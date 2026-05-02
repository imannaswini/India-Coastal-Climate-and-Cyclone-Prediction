# 🛡️ COASTGUARD: Enterprise Risk Intelligence

**COASTGUARD** is a high-fidelity, real-time cyclonic surveillance and coastal risk intelligence platform. Designed for maritime safety and operational command, it transforms raw meteorological satellite data into actionable predictive insights via a state-of-the-art glassmorphic dashboard.

---

## 🚀 Key Modernizations (v2.1 "Apex")

### 📊 Apex Intelligence Analytics
*   **Weather Intelligence Charts**: Implemented a "Windy/NASA" style visualization suite featuring dual-axis climate correlation (Risk Index vs. SST).
*   **Neon Path Dynamics**: High-contrast Cyber-Orange and Electric-Blue lines with neon glow (`shadowBlur`) for maximum anomaly visibility.
*   **Stratified Risk Zones**: Horizontal background context zones (Safe/Advisory/Alert) providing instant situational awareness.
*   **Glass HUD Tooltips**: Minimalist floating HUDs with dynamic status indicators (`[ ALERT ]`, `[ WARN ]`, `[ OK ]`).

### 🌐 Geospatial Intelligence
*   **White-Theme Map Array**: Transitioned to a high-visibility light geospatial theme for superior landmark contrast.
*   **Micro-Marker Precision**: Reduced marker scale by 50% for a cleaner, high-density visualization of the 7 primary coastal sectors.
*   **Instant Sector Injection**: Click-to-focus interactivity that synchronizes telemetry and analytics with the map's focal point.

### 📡 Real-Time Data Pipeline
*   **Automated Sync Engine**: Removed manual sync buttons; the platform now features a 60-second background auto-refresh to maintain data freshness.
*   **National Aggregation**: A dedicated "National Overview" mode that computes arithmetic means for risk, pressure, and rain across all sectors.
*   **High-Precision Telemetry**: 
    *   **24h Rain Accumulation**: Track total daily moisture levels.
    *   **Absolute Pressure**: Direct hPa monitoring (not just deltas).
    *   **3-Decimal Fidelity**: Ultra-precise readings for SST and wind intensity.

---

## 🛠️ Technical Architecture

*   **Frontend**: HTML5, CSS3 (Enterprise Glassmorphism), Vanilla JavaScript (ES6+), Leaflet.js, Chart.js.
*   **Backend**: Python 3.x, FastAPI (Asynchronous), Uvicorn.
*   **Database**: SQLite3 with advanced aggregation and history tracking.
*   **Data Pipeline**: Automated ingestion, feature engineering, and live ML inference engine.

---

## 🚦 Getting Started

1.  **Start the Backend**:
    ```bash
    python api.py
    ```
2.  **Launch the Control Center**:
    Open `dashboard_ui/index.html` via a local server (e.g., `npx live-server`).
3.  **Automatic Initialization**:
    The system will automatically trigger a data sync upon the first load to ensure you are viewing the most recent meteorological cycle.

---

## 📂 Project Structure

```text
├── api.py              # FastAPI Backend (REST Endpoints)
├── dashboard_ui/       # Enterprise Dashboard
│   ├── index.html      # Glassmorphic UI Structure
│   ├── styles.css      # Design System & UI Tokens
│   └── script.js       # Real-time Core & Chart Orchestration
├── pipeline/           # Data Intelligence Layer
│   ├── ingestion.py    # Satellite API Ingestion (NASA/Meteo)
│   ├── inference.py    # Live Risk Calculation & ML Scoring
│   ├── scheduler.py    # Background Pipeline Orchestrator
│   └── alerts.py       # Rule-based Emergency Logic
├── database/           # Persistence Layer
│   └── db.py           # SQLite Aggregation & CRUD Operations
└── data/               # Meteorological Intelligence Storage
```

---

## 🛡️ License
Copyright © 2026 COASTGUARD Enterprise Operations. All rights reserved.
