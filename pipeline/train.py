import pandas as pd
import numpy as np
import os
import logging
import pickle
import json
import matplotlib.pyplot as plt
import seaborn as sns
from datetime import datetime
from sklearn.model_selection import train_test_split, GridSearchCV, cross_val_score
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import (classification_report, roc_auc_score, confusion_matrix, 
                             roc_curve, precision_recall_curve, accuracy_score)
from xgboost import XGBClassifier
from imblearn.over_sampling import SMOTE

# --- Configuration ---
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROC_DIR = os.path.join(BASE_DIR, "data", "processed")
MODELS_DIR = os.path.join(BASE_DIR, "models")
EVAL_DIR = os.path.join(MODELS_DIR, "evaluation")
INPUT_FILE = os.path.join(PROC_DIR, "labeled_climate_data.csv")
METADATA_FILE = os.path.join(MODELS_DIR, "model_metadata.json")
LOG_FILE = os.path.join(PROC_DIR, "preprocessing_log.txt")

os.makedirs(MODELS_DIR, exist_ok=True)
os.makedirs(EVAL_DIR, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[
        logging.FileHandler(LOG_FILE, mode='a'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

def engineer_training_features(df):
    logger.info("Task 2: Applying feature engineering logic...")
    df['sst_above_threshold'] = (df['sst'] > 26.5).astype(int)
    df['sst_danger_zone'] = (df['sst'] > 28.5).astype(int)
    
    reg_means = df.groupby('region')['pressure'].transform('mean')
    df['pressure_anomaly'] = df['pressure'] - reg_means
    
    df['low_pressure_flag'] = (df['pressure'] < 1010).astype(int)
    df['high_wind_flag'] = (df['wind_speed'] > 5.0).astype(int)
    
    df['distance_from_equator'] = df['latitude'].abs()
    df['bay_of_bengal_flag'] = ((df['longitude'] > 80) & (df['latitude'] > 8)).astype(int)
    df['arabian_sea_flag'] = (df['longitude'] < 77).astype(int)
    
    return df

def save_plots(models_dict, X_test, y_test, feature_names):
    logger.info("Task 3: Generating evaluation plots...")
    
    # 1. Confusion Matrix
    fig, axes = plt.subplots(1, 2, figsize=(12, 5))
    for i, (name, model) in enumerate(models_dict.items()):
        y_pred = model.predict(X_test)
        cm = confusion_matrix(y_test, y_pred)
        sns.heatmap(cm, annot=True, fmt='d', cmap='Blues', ax=axes[i])
        axes[i].set_title(f"Confusion Matrix: {name}")
        axes[i].set_xlabel("Predicted")
        axes[i].set_ylabel("Actual")
    plt.tight_layout()
    plt.savefig(os.path.join(EVAL_DIR, "confusion_matrices.png"))
    plt.close()

    # 2. Feature Importance (Random Forest)
    rf_model = models_dict['RandomForest']
    if hasattr(rf_model, 'best_estimator_'):
        importances = rf_model.best_estimator_.feature_importances_
    else:
        importances = rf_model.feature_importances_
        
    feat_importances = pd.Series(importances, index=feature_names).sort_values(ascending=False)
    plt.figure(figsize=(10, 6))
    feat_importances.head(15).plot(kind='barh', color='teal')
    plt.title("Top 15 Features (Random Forest)")
    plt.gca().invert_yaxis()
    plt.tight_layout()
    plt.savefig(os.path.join(EVAL_DIR, "feature_importance.png"))
    plt.close()

    # 3. ROC Curve
    plt.figure(figsize=(10, 6))
    for name, model in models_dict.items():
        y_prob = model.predict_proba(X_test)[:, 1]
        fpr, tpr, _ = roc_curve(y_test, y_prob)
        auc = roc_auc_score(y_test, y_prob)
        plt.plot(fpr, tpr, label=f"{name} (AUC = {auc:.3f})")
    plt.plot([0, 1], [0, 1], 'k--')
    plt.xlabel("False Positive Rate")
    plt.ylabel("True Positive Rate")
    plt.title("ROC Curve Comparison")
    plt.legend()
    plt.savefig(os.path.join(EVAL_DIR, "roc_curve.png"))
    plt.close()

    # 4. Precision-Recall Curve
    plt.figure(figsize=(10, 6))
    for name, model in models_dict.items():
        y_prob = model.predict_proba(X_test)[:, 1]
        precision, recall, _ = precision_recall_curve(y_test, y_prob)
        plt.plot(recall, precision, label=name)
    plt.xlabel("Recall")
    plt.ylabel("Precision")
    plt.title("Precision-Recall Curve Comparison")
    plt.legend()
    plt.savefig(os.path.join(EVAL_DIR, "pr_curve.png"))
    plt.close()

def run_ml_pipeline():
    logger.info("--- Starting Advanced ML Training Pipeline ---")
    
    if not os.path.exists(INPUT_FILE):
        logger.error(f"Input labeled file not found: {INPUT_FILE}")
        return
        
    df = pd.read_csv(INPUT_FILE)
    df = engineer_training_features(df)
    
    # Data Cleaning
    feature_cols = [
        'sst', 'wind_speed', 'pressure', 'rainfall',
        'sst_above_threshold', 'sst_danger_zone',
        'pressure_anomaly', 'low_pressure_flag',
        'high_wind_flag',
        'distance_from_equator', 'bay_of_bengal_flag', 'arabian_sea_flag'
    ]
    X = df[feature_cols]
    y = df['cyclone_hit']
    
    # Impute missing features if any
    X = X.fillna(X.mean())

    # Split
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)
    
    # SMOTE on Training Set
    logger.info(f"Class distribution before SMOTE: {np.bincount(y_train)}")
    smote = SMOTE(random_state=42)
    X_train_sm, y_train_sm = smote.fit_resample(X_train, y_train)
    logger.info(f"Class distribution after SMOTE: {np.bincount(y_train_sm)}")

    # 1. Random Forest Grid Search
    logger.info("Tuning Random Forest...")
    rf_params = {
        'n_estimators': [100, 200],
        'max_depth': [5, 10, 15],
        'min_samples_leaf': [2, 5]
    }
    rf_grid = GridSearchCV(RandomForestClassifier(random_state=42, class_weight='balanced'), 
                           rf_params, cv=5, scoring='f1', n_jobs=-1)
    rf_grid.fit(X_train_sm, y_train_sm)
    
    # 2. XGBoost Grid Search
    logger.info("Tuning XGBoost...")
    xgb_params = {
        'n_estimators': [100, 150],
        'max_depth': [3, 5],
        'learning_rate': [0.1, 0.2]
    }
    xgb_grid = GridSearchCV(XGBClassifier(random_state=42), 
                            xgb_params, cv=5, scoring='f1', n_jobs=-1)
    xgb_grid.fit(X_train_sm, y_train_sm)
    
    models = {'RandomForest': rf_grid, 'XGBoost': xgb_grid}
    save_plots(models, X_test, y_test, feature_cols)
    
    # Evaluation Report
    results = {}
    print("\n" + "="*50)
    print("TASK 2: MODEL EVALUATION REPORT")
    print("="*50)
    
    for name, grid in models.items():
        best_model = grid.best_estimator_
        y_pred = best_model.predict(X_test)
        y_prob = best_model.predict_proba(X_test)[:, 1]
        
        report = classification_report(y_test, y_pred, output_dict=True)
        f1_class1 = report['1']['f1-score']
        
        print(f"\n--- {name} ---")
        print(f"Best Params: {grid.best_params_}")
        print(f"Test Accuracy: {accuracy_score(y_test, y_pred):.4f}")
        print(f"ROC-AUC: {roc_auc_score(y_test, y_prob):.4f}")
        print(f"F1 Score (Cyclone Class): {f1_class1:.4f}")
        
        cm = confusion_matrix(y_test, y_pred)
        tn, fp, fn, tp = cm.ravel()
        print(f"Confusion Matrix:\n{cm}")
        print(f" - TN ({tn}): Successfully predicted NO cyclone")
        print(f" - FP ({fp}): False Alarm (Predicted cyclone, none occurred)")
        print(f" - FN ({fn}): Missed Event (Actual cyclone, missed by model)")
        print(f" - TP ({tp}): Successful Prediction of cyclone")
        
        results[name] = {
            'model': best_model,
            'f1': f1_class1,
            'auc': roc_auc_score(y_test, y_prob),
            'params': grid.best_params_
        }

    # Selection
    selected_name = 'RandomForest' if results['RandomForest']['f1'] >= results['XGBoost']['f1'] else 'XGBoost'
    selected = results[selected_name]
    print(f"\n>>> Selected Model: {selected_name} based on Cyclone F1 Score.")
    
    # Save
    model_path = os.path.join(MODELS_DIR, "cyclone_risk_model.pkl")
    with open(model_path, 'wb') as f:
        pickle.dump(selected['model'], f)
        
    metadata = {
        "model_type": selected_name,
        "best_params": selected['params'],
        "f1_cyclone_class": selected['f1'],
        "roc_auc": selected['auc'],
        "training_date": datetime.now().strftime("%Y-%m-%d"),
        "training_data_rows": len(df),
        "positive_examples": int(y.sum()),
        "features_used": feature_cols
    }
    with open(METADATA_FILE, 'w') as f:
        json.dump(metadata, f, indent=2)
        
    # Validation Checks
    print("\n--- Validation Checks ---")
    if selected['f1'] < 0.60:
        print("WARNING: Test F1 for cyclone class is below 0.60! Model is not reliable.")
    
    test_acc = accuracy_score(y_test, selected['model'].predict(X_test))
    if test_acc > 0.99:
        print("WARNING: Test accuracy > 99%! Potential overfitting or data leakage.")
        
    rf_best = rf_grid.best_estimator_
    top_feature = feature_cols[np.argmax(rf_best.feature_importances_)]
    if top_feature in ['latitude', 'longitude']:
        print(f"WARNING: Feature importance shows {top_feature} as top feature! Potential geographic memorization.")
    else:
        print(f"Top feature: {top_feature} (Passes logic check)")

    print("\nAll tasks complete. Files saved to models/ and data/processed/.")

if __name__ == "__main__":
    run_ml_pipeline()
