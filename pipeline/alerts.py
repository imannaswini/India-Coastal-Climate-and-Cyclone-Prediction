import os
import json
import logging
from datetime import datetime, timedelta
from database.db import get_connection

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ALERTS_DIR = os.path.join(BASE_DIR, "data", "alerts")
os.makedirs(ALERTS_DIR, exist_ok=True)

logger = logging.getLogger(__name__)

def is_alert_active_recently(region, alert_type):
    conn = get_connection()
    c = conn.cursor()
    # Check if there is an active alert of the same type in the last 6 hours
    time_limit = (datetime.utcnow() - timedelta(hours=6)).strftime("%Y-%m-%d %H:%M:%S")
    c.execute('''
        SELECT id FROM alerts 
        WHERE region = ? AND alert_type = ? AND is_active = 1 AND timestamp >= ?
    ''', (region, alert_type, time_limit))
    row = c.fetchone()
    conn.close()
    return row is not None

def generate_alert_dict(region, timestamp, alert_type, severity, message):
    return {
        "region": region,
        "timestamp": timestamp,
        "alert_type": alert_type,
        "severity": severity,
        "message": message
    }

def evaluate_alerts(predictions):
    logger.info("Evaluating Alerts...")
    triggered_alerts = []
    
    for region, p in predictions.items():
        timestamp = p['timestamp']
        
        # Count precursor flags
        active_flags = []
        if p.get('sst_above_threshold', 0): active_flags.append("High SST")
        if p.get('low_pressure_flag', 0): active_flags.append("Low Pressure")
        if p.get('high_wind_flag', 0): active_flags.append("High Wind")
        if p.get('heavy_rainfall_flag', 0): active_flags.append("Heavy Rain")
        
        # Type 4: Cyclone Warning (CRITICAL)
        if p['final_cyclone_probability'] > 0.65 and p['sst_celsius'] > 28.5 and p['pressure_hpa'] < 1010:
            if not is_alert_active_recently(region, "Cyclone Warning"):
                msg = f"CYCLONE WARNING for {region}. High probability cyclone conditions detected. Probability: {p['final_cyclone_probability']*100:.1f}%. SST: {p['sst_celsius']}°C. Pressure: {p['pressure_hpa']}hPa. Take immediate precautions."
                triggered_alerts.append(generate_alert_dict(region, timestamp, "Cyclone Warning", "CRITICAL", msg))
        
        # Type 3: Cyclone Watch (WARNING)
        elif p['final_cyclone_probability'] > 0.40 and len(active_flags) >= 2:
            if not is_alert_active_recently(region, "Cyclone Watch"):
                msg = f"Cyclone Watch issued for {region}. Probability: {p['final_cyclone_probability']*100:.1f}%. Conditions: {', '.join(active_flags)}."
                triggered_alerts.append(generate_alert_dict(region, timestamp, "Cyclone Watch", "WARNING", msg))
                
        # Type 1: Heavy Rainfall Warning (WARNING)
        if p['rainfall_mm'] > 0.5:
            if not is_alert_active_recently(region, "Heavy Rainfall Warning"):
                msg = f"Heavy rainfall conditions detected over {region}. Current: {p['rainfall_mm']}mm. Coastal flooding risk elevated."
                triggered_alerts.append(generate_alert_dict(region, timestamp, "Heavy Rainfall Warning", "WARNING", msg))
                
        # Type 2: Low Pressure Alert (WARNING)
        if p['pressure_hpa'] < 1010:
            if not is_alert_active_recently(region, "Low Pressure Alert"):
                msg = f"Anomalous low pressure detected over {region}. Current: {p['pressure_hpa']}hPa. Monitor for deepening system."
                triggered_alerts.append(generate_alert_dict(region, timestamp, "Low Pressure Alert", "WARNING", msg))
                
        # Type 5: Extreme Wind Alert (WARNING)
        if p['wind_speed_knots'] > 5.0:
            if not is_alert_active_recently(region, "Extreme Wind Alert"):
                msg = f"Elevated wind speeds detected over {region}. Current: {p['wind_speed_knots']}kts. Coastal marine advisory issued."
                triggered_alerts.append(generate_alert_dict(region, timestamp, "Extreme Wind Alert", "WARNING", msg))
                
        p['alerts'] = [a for a in triggered_alerts if a['region'] == region]

    # Save snapshot of all active alerts
    conn = get_connection()
    c = conn.cursor()
    c.execute('SELECT * FROM alerts WHERE is_active = 1')
    active_db_alerts = [dict(r) for r in c.fetchall()]
    conn.close()
    
    # Merge existing active alerts with newly triggered ones
    current_snapshot = active_db_alerts + triggered_alerts
    
    with open(os.path.join(ALERTS_DIR, "current_alerts.json"), "w") as f:
        json.dump(current_snapshot, f, indent=2)
        
    for a in triggered_alerts:
        logger.info(f"ALERT [{a['severity']}] {a['region']}: {a['alert_type']}")
        
    return triggered_alerts
