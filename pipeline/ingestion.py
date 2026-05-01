import requests
import pandas as pd
import os
import logging
from datetime import datetime
import time
from database.db import get_connection

# --- Configuration ---
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIVE_READINGS_DIR = os.path.join(BASE_DIR, "data", "raw", "live_readings")
os.makedirs(LIVE_READINGS_DIR, exist_ok=True)

logger = logging.getLogger(__name__)

REGIONS = {
    "Andhra Pradesh":  {"lat": 15.9, "lon": 80.5},
    "Gujarat":         {"lat": 22.3, "lon": 69.7},
    "Kerala":          {"lat": 9.5,  "lon": 76.3},
    "Maharashtra":     {"lat": 17.5, "lon": 73.2},
    "Odisha Coast":    {"lat": 20.5, "lon": 85.8},
    "Tamil Nadu":      {"lat": 10.8, "lon": 79.8},
    "West Bengal":     {"lat": 21.6, "lon": 87.9}
}

def get_fallback_reading(region):
    conn = get_connection()
    c = conn.cursor()
    c.execute('''
        SELECT rainfall, wind_speed, pressure, sst 
        FROM live_readings 
        WHERE region = ? 
        ORDER BY timestamp DESC LIMIT 1
    ''', (region,))
    row = c.fetchone()
    conn.close()
    if row:
        return dict(row)
    return {"rainfall": 0.0, "wind_speed": 0.0, "pressure": 1010.0, "sst": 28.0}

def fetch_live_data():
    logger.info("Starting Live Data Fetch from Open-Meteo APIs")
    
    current_time = datetime.utcnow()
    timestamp_str = current_time.strftime("%Y-%m-%d_%H")
    
    results = {}
    raw_results = []
    
    for region, coords in REGIONS.items():
        lat = coords['lat']
        lon = coords['lon']
        logger.info(f"Fetching data for {region} ({lat}, {lon})")
        
        fallback = get_fallback_reading(region)
        rainfall = fallback['rainfall']
        wind_speed = fallback['wind_speed']
        pressure = fallback['pressure']
        sst = fallback['sst']
        
        forecast_success = False
        marine_success = False
        
        try:
            # 1. Fetch from standard forecast API
            forecast_url = (
                f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}"
                f"&hourly=windspeed_10m,surface_pressure,precipitation,temperature_2m"
                f"&past_days=1&windspeed_unit=kn"
            )
            resp = requests.get(forecast_url, timeout=10)
            if resp.status_code == 200:
                data = resp.json()
                hourly = data.get('hourly', {})
                
                if hourly:
                    times = pd.to_datetime(hourly['time'])
                    now_idx = (times <= current_time).sum() - 1
                    if now_idx < 0: now_idx = 0
                    
                    past_24_idx = max(0, now_idx - 23)
                    precip_array = hourly.get('precipitation', [])
                    if precip_array:
                        rainfall = sum(x for x in precip_array[past_24_idx:now_idx+1] if x is not None)
                        
                    past_6_idx = max(0, now_idx - 5)
                    wind_array = hourly.get('windspeed_10m', [])
                    if wind_array:
                        valid_winds = [x for x in wind_array[past_6_idx:now_idx+1] if x is not None]
                        if valid_winds:
                            wind_speed = sum(valid_winds) / len(valid_winds)
                            
                    pressure_array = hourly.get('surface_pressure', [])
                    if pressure_array and pressure_array[now_idx] is not None:
                        pressure = pressure_array[now_idx]
                        
                    temp_array = hourly.get('temperature_2m', [])
                    if temp_array and temp_array[now_idx] is not None:
                        sst = temp_array[now_idx]
                        
                forecast_success = True
            else:
                logger.error(f"Forecast API failed for {region}: {resp.status_code}")

            # 2. Fetch from marine API
            marine_url = (
                f"https://marine-api.open-meteo.com/v1/marine?latitude={lat}&longitude={lon}"
                f"&hourly=sea_surface_temperature&past_days=1"
            )
            m_resp = requests.get(marine_url, timeout=10)
            if m_resp.status_code == 200:
                m_data = m_resp.json()
                m_hourly = m_data.get('hourly', {})
                if m_hourly:
                    m_times = pd.to_datetime(m_hourly['time'])
                    m_now_idx = (m_times <= current_time).sum() - 1
                    if m_now_idx < 0: m_now_idx = 0
                    
                    sst_array = m_hourly.get('sea_surface_temperature', [])
                    if sst_array and m_now_idx < len(sst_array) and sst_array[m_now_idx] is not None:
                        sst = sst_array[m_now_idx]
                        marine_success = True
            else:
                logger.warning(f"Marine API failed for {region}: {m_resp.status_code}. Using temperature_2m fallback.")
                
        except Exception as e:
            logger.error(f"Error fetching data for {region}: {e}")
            
        logger.info(f"  -> Rainfall: {rainfall:.1f}mm, Wind: {wind_speed:.1f}kn, Pressure: {pressure:.1f}hPa, SST: {sst:.1f}°C")
        
        region_data = {
            "region": region,
            "latitude": float(lat),
            "longitude": float(lon),
            "timestamp": current_time.strftime("%Y-%m-%d %H:%M:%S"),
            "rainfall_mm": float(rainfall),
            "wind_speed_knots": float(wind_speed),
            "pressure_hpa": float(pressure),
            "sst_celsius": float(sst)
        }
        
        results[region] = region_data
        raw_results.append(region_data)
        time.sleep(0.5) 
        
    df = pd.DataFrame(raw_results)
    out_file = os.path.join(LIVE_READINGS_DIR, f"live_{timestamp_str}.csv")
    df.to_csv(out_file, index=False)
    logger.info(f"Live data fetched successfully. Saved to {out_file}")
    
    return results

if __name__ == "__main__":
    from database.db import init_db
    init_db()
    fetch_live_data()
