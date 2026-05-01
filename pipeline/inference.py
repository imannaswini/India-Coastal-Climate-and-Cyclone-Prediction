import os
import json
import pickle
import numpy as np
import pandas as pd
import logging

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODELS_DIR = os.path.join(BASE_DIR, "models")
PROC_DIR = os.path.join(BASE_DIR, "data", "processed")

MODEL_FILE = os.path.join(MODELS_DIR, "cyclone_risk_model.pkl")
PARAMS_FILE = os.path.join(PROC_DIR, "normalization_params.json")
METADATA_FILE = os.path.join(MODELS_DIR, "model_metadata.json")

logger = logging.getLogger(__name__)

def load_resources():
    with open(MODEL_FILE, 'rb') as f:
        model = pickle.load(f)
    with open(PARAMS_FILE, 'r') as f:
        params = json.load(f)
    with open(METADATA_FILE, 'r') as f:
        metadata = json.load(f)
    return model, params, metadata

def run_inference(live_data):
    logger.info("Starting Inference Engine...")
    model, params, metadata = load_resources()
    features_used = metadata['features_used']
    
    predictions = {}
    
    for region, data in live_data.items():
        # 1. Feature Engineering exactly as in training
        lat = data['latitude']
        lon = data['longitude']
        sst = data['sst_celsius']
        pressure = data['pressure_hpa']
        wind_speed = data['wind_speed_knots']
        rainfall = data['rainfall_mm']
        
        sst_above_threshold = int(sst > 26.5)
        sst_danger_zone = int(sst > 28.5)
        
        regional_mean = params.get('regional_pressure_means', {}).get(region, 1010.0)
        pressure_anomaly = pressure - regional_mean
        
        low_pressure_flag = int(pressure < 1010)
        high_wind_flag = int(wind_speed > 5.0)
        heavy_rainfall_flag = int(rainfall > 0.5)
        
        distance_from_equator = abs(lat)
        bay_of_bengal_flag = int(lon > 80 and lat > 8)
        arabian_sea_flag = int(lon < 77)
        
        # 2. Normalization (though RF may not strictly need it, we compute it per instructions)
        # Note: if the model_metadata.json lists raw features, we pass raw features.
        norm_data = {}
        for col, val in [('sst', sst), ('wind_speed', wind_speed), ('pressure', pressure), ('rainfall', rainfall)]:
            vmin = params[col]['min']
            vmax = params[col]['max']
            denom = vmax - vmin if vmax > vmin else 1.0
            norm_data[f"{col}_norm"] = (val - vmin) / denom
            
        # 3. Composite risk score (same logic as features.py)
        risk_score = 0
        if sst > 26.5: risk_score += 2
        if sst > 28.5: risk_score += 1
        if pressure < 1010: risk_score += 3
        if pressure_anomaly < -2: risk_score += 1
        if wind_speed > 5.0: risk_score += 2
        if rainfall > 0.5: risk_score += 1
        
        if risk_score <= 2: risk_level = 'Low'
        elif risk_score <= 5: risk_level = 'Moderate'
        else: risk_level = 'High'
        
        # 4. Prepare feature vector for ML
        feature_dict = {
            "sst": sst,
            "wind_speed": wind_speed,
            "pressure": pressure,
            "rainfall": rainfall,
            "sst_above_threshold": sst_above_threshold,
            "sst_danger_zone": sst_danger_zone,
            "pressure_anomaly": pressure_anomaly,
            "low_pressure_flag": low_pressure_flag,
            "high_wind_flag": high_wind_flag,
            "distance_from_equator": distance_from_equator,
            "bay_of_bengal_flag": bay_of_bengal_flag,
            "arabian_sea_flag": arabian_sea_flag
        }
        
        # Ensure ordering matches features_used
        x_input = pd.DataFrame([feature_dict])[features_used]
        
        ml_probability = float(model.predict_proba(x_input)[0, 1])
        
        # 5. Blend probabilities
        final_probability = (0.6 * ml_probability) + (0.4 * (risk_score / 10.0))
        
        predictions[region] = {
            "region": region,
            "timestamp": data['timestamp'],
            "rainfall_mm": rainfall,
            "wind_speed_knots": wind_speed,
            "pressure_hpa": pressure,
            "sst_celsius": sst,
            "risk_score": risk_score,
            "risk_level": risk_level,
            "ml_cyclone_probability": ml_probability,
            "final_cyclone_probability": final_probability,
            "sst_above_threshold": sst_above_threshold,
            "low_pressure_flag": low_pressure_flag,
            "high_wind_flag": high_wind_flag,
            "heavy_rainfall_flag": heavy_rainfall_flag,
            "alerts": [] # To be populated by alerts.py
        }
        logger.info(f"Inference for {region}: Risk={risk_level} ({risk_score}/10), Final Prob={final_probability*100:.1f}%")
        
    return predictions

if __name__ == "__main__":
    pass
