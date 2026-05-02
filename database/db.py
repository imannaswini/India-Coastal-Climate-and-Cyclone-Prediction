import sqlite3
import os
import logging
from datetime import datetime, timedelta

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(BASE_DIR, "data", "coastguard.db")

# Ensure data directory exists
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

def get_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_connection()
    c = conn.cursor()
    
    # Table 1: live_readings
    c.execute('''
        CREATE TABLE IF NOT EXISTS live_readings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            region TEXT,
            timestamp DATETIME,
            rainfall REAL,
            wind_speed REAL,
            pressure REAL,
            sst REAL,
            fetch_source TEXT
        )
    ''')
    
    # Table 2: predictions
    c.execute('''
        CREATE TABLE IF NOT EXISTS predictions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            region TEXT,
            timestamp DATETIME,
            risk_score INTEGER,
            risk_level TEXT,
            ml_probability REAL,
            final_probability REAL,
            sst_above_threshold INTEGER,
            low_pressure_flag INTEGER,
            high_wind_flag INTEGER,
            heavy_rainfall_flag INTEGER
        )
    ''')
    
    # Table 3: alerts
    c.execute('''
        CREATE TABLE IF NOT EXISTS alerts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            region TEXT,
            timestamp DATETIME,
            alert_type TEXT,
            severity TEXT,
            message TEXT,
            is_active INTEGER,
            resolved_at DATETIME
        )
    ''')
    
    # Table 4: inference_log
    c.execute('''
        CREATE TABLE IF NOT EXISTS inference_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_timestamp DATETIME,
            regions_processed INTEGER,
            alerts_generated INTEGER,
            errors TEXT,
            duration_seconds REAL
        )
    ''')
    
    conn.commit()
    conn.close()

def insert_reading(region, data):
    conn = get_connection()
    c = conn.cursor()
    c.execute('''
        INSERT INTO live_readings 
        (region, timestamp, rainfall, wind_speed, pressure, sst, fetch_source)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    ''', (
        region, 
        data['timestamp'], 
        data['rainfall_mm'], 
        data['wind_speed_knots'], 
        data['pressure_hpa'], 
        data['sst_celsius'], 
        data.get('fetch_source', 'Open-Meteo')
    ))
    conn.commit()
    conn.close()

def insert_prediction(region, data):
    conn = get_connection()
    c = conn.cursor()
    c.execute('''
        INSERT INTO predictions 
        (region, timestamp, risk_score, risk_level, ml_probability, final_probability, 
         sst_above_threshold, low_pressure_flag, high_wind_flag, heavy_rainfall_flag)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', (
        region, 
        data['timestamp'], 
        data['risk_score'], 
        data['risk_level'], 
        data['ml_cyclone_probability'], 
        data['final_cyclone_probability'],
        data.get('sst_above_threshold', 0),
        data.get('low_pressure_flag', 0),
        data.get('high_wind_flag', 0),
        data.get('heavy_rainfall_flag', 0)
    ))
    conn.commit()
    conn.close()

def insert_alert(region, alert):
    conn = get_connection()
    c = conn.cursor()
    c.execute('''
        INSERT INTO alerts 
        (region, timestamp, alert_type, severity, message, is_active, resolved_at)
        VALUES (?, ?, ?, ?, ?, 1, NULL)
    ''', (
        region, 
        alert['timestamp'], 
        alert['alert_type'], 
        alert['severity'], 
        alert['message']
    ))
    conn.commit()
    conn.close()

def log_inference_run(run_timestamp, regions_processed, alerts_generated, errors, duration_seconds):
    conn = get_connection()
    c = conn.cursor()
    c.execute('''
        INSERT INTO inference_log 
        (run_timestamp, regions_processed, alerts_generated, errors, duration_seconds)
        VALUES (?, ?, ?, ?, ?)
    ''', (run_timestamp, regions_processed, alerts_generated, errors, duration_seconds))
    conn.commit()
    conn.close()

def get_latest_predictions():
    conn = get_connection()
    c = conn.cursor()
    c.execute('''
        SELECT p.* FROM predictions p
        INNER JOIN (
            SELECT region, MAX(timestamp) as max_ts 
            FROM predictions GROUP BY region
        ) grouped_p 
        ON p.region = grouped_p.region AND p.timestamp = grouped_p.max_ts
    ''')
    rows = c.fetchall()
    conn.close()
    return [dict(r) for r in rows]

def get_active_alerts():
    conn = get_connection()
    c = conn.cursor()
    c.execute('SELECT * FROM alerts WHERE is_active = 1')
    rows = c.fetchall()
    conn.close()
    return [dict(r) for r in rows]

def get_region_history(region, days=30):
    conn = get_connection()
    c = conn.cursor()
    time_limit = (datetime.utcnow() - timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")
    c.execute('''
        SELECT * FROM predictions 
        WHERE region = ? AND timestamp >= ? 
        ORDER BY timestamp DESC
    ''', (region, time_limit))
    rows = c.fetchall()
    conn.close()
    return [dict(r) for r in rows]

def resolve_old_alerts():
    conn = get_connection()
    c = conn.cursor()
    time_limit = (datetime.utcnow() - timedelta(hours=48)).strftime("%Y-%m-%d %H:%M:%S")
    resolved_time = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    c.execute('''
        UPDATE alerts 
        SET is_active = 0, resolved_at = ? 
        WHERE is_active = 1 AND timestamp <= ?
    ''', (resolved_time, time_limit))
    conn.commit()
    conn.close()
def get_latest_readings():
    conn = get_connection()
    c = conn.cursor()
    c.execute('''
        SELECT r.* FROM live_readings r
        INNER JOIN (
            SELECT region, MAX(timestamp) as max_ts 
            FROM live_readings GROUP BY region
        ) grouped_r 
        ON r.region = grouped_r.region AND r.timestamp = grouped_r.max_ts
    ''')
    rows = c.fetchall()
    conn.close()
    return [dict(r) for r in rows]

def get_latest_inference_log():
    conn = get_connection()
    c = conn.cursor()
    c.execute('SELECT * FROM inference_log ORDER BY run_timestamp DESC LIMIT 1')
    row = c.fetchone()
    conn.close()
    return dict(row) if row else None

def get_resolved_alerts(days=7):
    conn = get_connection()
    c = conn.cursor()
    time_limit = (datetime.utcnow() - timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")
    c.execute('SELECT * FROM alerts WHERE is_active = 0 AND resolved_at >= ? ORDER BY resolved_at DESC', (time_limit,))
    rows = c.fetchall()
    conn.close()
    return [dict(r) for r in rows]

def get_region_history_enriched(region, days=30):
    conn = get_connection()
    c = conn.cursor()
    time_limit = (datetime.utcnow() - timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")
    
    if region == "All":
        c.execute('''
            SELECT 
                p.timestamp,
                'National' as region,
                AVG(p.risk_score) as risk_score,
                'N/A' as risk_level,
                AVG(p.ml_probability) as ml_probability,
                AVG(p.final_probability) as final_probability,
                AVG(r.rainfall) as raw_rain,
                AVG(r.wind_speed) as raw_wind,
                AVG(r.pressure) as raw_pressure,
                AVG(r.sst) as raw_sst
            FROM predictions p
            LEFT JOIN live_readings r ON p.region = r.region AND p.timestamp = r.timestamp
            WHERE p.timestamp >= ? 
            GROUP BY p.timestamp
            ORDER BY p.timestamp ASC
        ''', (time_limit,))
    else:
        c.execute('''
            SELECT p.*, r.rainfall as raw_rain, r.wind_speed as raw_wind, r.pressure as raw_pressure, r.sst as raw_sst
            FROM predictions p
            LEFT JOIN live_readings r ON p.region = r.region AND p.timestamp = r.timestamp
            WHERE p.region = ? AND p.timestamp >= ? 
            ORDER BY p.timestamp ASC
        ''', (region, time_limit))
        
    rows = c.fetchall()
    conn.close()
    return [dict(r) for r in rows]
