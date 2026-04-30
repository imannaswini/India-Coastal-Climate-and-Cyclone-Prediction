import pandas as pd
import numpy as np
import requests
import os
import logging
from datetime import datetime

# --- Configuration ---
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROC_DIR = os.path.join(BASE_DIR, "data", "processed")
RAW_DIR = os.path.join(BASE_DIR, "data", "raw")
INPUT_FILE = os.path.join(RAW_DIR, "historical_weather_2015_2024.csv")
IBTRACS_URL = "https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-ibtracs/v04r01/access/csv/ibtracs.since1980.list.v04r01.csv"
IBTRACS_FILE = os.path.join(RAW_DIR, "ibtracs_ni_basin.csv")
OUTPUT_FILE = os.path.join(PROC_DIR, "labeled_climate_data.csv")
LOG_FILE = os.path.join(PROC_DIR, "preprocessing_log.txt")

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[
        logging.FileHandler(LOG_FILE, mode='a'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

def haversine(lat1, lon1, lat2, lon2):
    R = 6371  # Earth radius in km
    dlat = np.radians(lat2 - lat1)
    dlon = np.radians(lon2 - lon1)
    a = np.sin(dlat / 2) ** 2 + np.cos(np.radians(lat1)) * np.cos(np.radians(lat2)) * np.sin(dlon / 2) ** 2
    c = 2 * np.arctan2(np.sqrt(a), np.sqrt(1 - a))
    return R * c

def download_ibtracs():
    if not os.path.exists(IBTRACS_FILE):
        logger.info(f"Downloading IBTrACS data from {IBTRACS_URL}...")
        try:
            headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'}
            response = requests.get(IBTRACS_URL, headers=headers, timeout=60)
            if response.status_code == 200:
                with open(IBTRACS_FILE, 'wb') as f:
                    f.write(response.content)
                logger.info("Download complete.")
            else:
                logger.error(f"Download failed with status code: {response.status_code}")
                raise Exception(f"HTTP {response.status_code}")
        except Exception as e:
            logger.error(f"IBTrACS download failed: {e}. Check if internet is available.")
            raise
    else:
        logger.info("IBTrACS dataset already exists locally.")

def label_data():
    logger.info("--- Starting Enhanced Data Labeling Pipeline ---")
    
    download_ibtracs()
    
    # Load historical weather
    if not os.path.exists(INPUT_FILE):
        logger.error(f"Input file not found: {INPUT_FILE}. Please run ingestion.py first.")
        return
    
    df_weather = pd.read_csv(INPUT_FILE)
    df_weather['datetime'] = pd.to_datetime(df_weather['datetime'])
    df_weather['year_month'] = df_weather['datetime'].dt.strftime('%Y-%m')
    
    # Load IBTrACS
    df_ib = pd.read_csv(IBTRACS_FILE, low_memory=False, skiprows=[1])
    
    logger.info(f"Loaded IBTrACS with {len(df_ib)} rows.")
    logger.info(f"Unique Basins in file: {df_ib['BASIN'].unique()}")
    
    # Filter for Basin: NI and Season: 2015-2024
    df_ib = df_ib[df_ib['BASIN'].str.strip() == 'NI'].copy()
    logger.info(f"Rows after Basin filter: {len(df_ib)}")
    
    df_ib['ISO_TIME'] = pd.to_datetime(df_ib['ISO_TIME'], errors='coerce')
    df_ib = df_ib.dropna(subset=['ISO_TIME'])
    
    logger.info(f"Years available in NI basin: {df_ib['ISO_TIME'].dt.year.unique()}")
    
    df_ib = df_ib[df_ib['ISO_TIME'].dt.year >= 2015]
    logger.info(f"Rows after Year filter: {len(df_ib)}")
    
    df_ib['year_month'] = df_ib['ISO_TIME'].dt.strftime('%Y-%m')
    
    # Clean Lat/Lon
    df_ib['LAT'] = pd.to_numeric(df_ib['LAT'], errors='coerce')
    df_ib['LON'] = pd.to_numeric(df_ib['LON'], errors='coerce')
    df_ib = df_ib.dropna(subset=['LAT', 'LON'])
    
    logger.info(f"Final cyclone points for processing: {len(df_ib)}")
    
    # Labeling Logic
    ib_groups = {name: group for name, group in df_ib.groupby('year_month')}
    
    cyclone_hit_labels = []
    contributing_cyclones = set()
    
    for idx, row in df_weather.iterrows():
        ym = row['year_month']
        if ym not in ib_groups:
            cyclone_hit_labels.append(0)
            continue
            
        group = ib_groups[ym]
        distances = haversine(row['latitude'], row['longitude'], group['LAT'].values, group['LON'].values)
        
        mask = distances < 200
        if np.any(mask):
            cyclone_hit_labels.append(1)
            # Log the names/IDs of cyclones that caused this hit
            names = group.loc[mask, 'NAME'].unique().tolist()
            ids = group.loc[mask, 'SID'].unique().tolist()
            contributing_cyclones.update([f"{n} ({i})" for n, i in zip(names, ids)])
        else:
            cyclone_hit_labels.append(0)
            
    df_weather['cyclone_hit'] = cyclone_hit_labels
    
    # Task 1 Reporting
    print("\n" + "="*50)
    print("TASK 1: LABELING SUMMARY REPORT")
    print("="*50)
    total = len(df_weather)
    pos = sum(cyclone_hit_labels)
    neg = total - pos
    
    print(f"Total rows in labeled dataset: {total}")
    print(f"Total positive labels (cyclone_hit = 1): {pos}")
    print(f"Total negative labels (cyclone_hit = 0): {neg}")
    print(f"Class imbalance ratio: {(pos/total)*100:.2f}% positive")
    
    print("\nPositive labels by region:")
    print(df_weather[df_weather['cyclone_hit'] == 1]['region'].value_counts())
    
    print("\nPositive labels by year:")
    df_weather['year'] = df_weather['datetime'].dt.year
    print(df_weather[df_weather['cyclone_hit'] == 1]['year'].value_counts().sort_index())
    
    print("\nUnique cyclones involved in hits:")
    for c in sorted(list(contributing_cyclones)):
        print(f" - {c}")
    
    # Save output
    df_weather.to_csv(OUTPUT_FILE, index=False)
    logger.info(f"Labeled dataset saved to {OUTPUT_FILE}")

if __name__ == "__main__":
    label_data()
