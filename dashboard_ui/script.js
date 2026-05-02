document.addEventListener('DOMContentLoaded', () => {
    const API_BASE = 'http://localhost:8000';

    // --- Preloader Removal ---
    const preloader = document.getElementById('preloader');
    const hidePreloader = () => {
        if (preloader) {
            preloader.style.opacity = '0';
            setTimeout(() => preloader.style.display = 'none', 800);
        }
    };

    const safetyTimer = setTimeout(hidePreloader, 3000);
    window.addEventListener('load', () => {
        clearTimeout(safetyTimer);
        hidePreloader();
    });

    // --- State/Region Coordinates ---
    const REGIONS_DATA = {
        "Andhra Pradesh": { lat: 15.9, lon: 80.5, zoom: 7 },
        "Gujarat": { lat: 22.3, lon: 69.7, zoom: 7 },
        "Kerala": { lat: 9.5, lon: 76.3, zoom: 8 },
        "Maharashtra": { lat: 17.5, lon: 73.2, zoom: 7 },
        "Odisha Coast": { lat: 20.5, lon: 85.8, zoom: 7 },
        "Tamil Nadu": { lat: 10.8, lon: 79.8, zoom: 7 },
        "West Bengal": { lat: 21.6, lon: 87.9, zoom: 8 },
        "All": { lat: 18, lon: 82, zoom: 5 }
    };

    // --- Global State ---
    let latestPredictions = [];
    let latestReadings = [];
    let latestAlerts = [];
    let currentRegion = "All";
    let currentSeverityFilter = "all";

    // --- Map Initialization ---
    const lightTiles = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; CARTO'
    });
    const satelliteTiles = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Esri'
    });

    let map = L.map('map', {
        center: [18, 82],
        zoom: 5,
        layers: [lightTiles],
        zoomControl: false,
        attributionControl: false
    });

    L.control.zoom({ position: 'topright' }).addTo(map);
    let markersLayer = L.layerGroup().addTo(map);

    // Map Mode Toggles
    document.getElementById('mapSurvey').addEventListener('click', () => {
        map.removeLayer(satelliteTiles);
        map.addLayer(lightTiles);
        document.getElementById('mapSurvey').classList.add('active');
        document.getElementById('mapSat').classList.remove('active');
    });

    document.getElementById('mapSat').addEventListener('click', () => {
        map.removeLayer(lightTiles);
        map.addLayer(satelliteTiles);
        document.getElementById('mapSat').classList.add('active');
        document.getElementById('mapSurvey').classList.remove('active');
    });

    // --- Core Sync Engine ---
    const navLinks = document.querySelectorAll('.nav-links li');
    const tabContents = document.querySelectorAll('.tab-content');
    const globalSelector = document.getElementById('stateSelect');

    navLinks.forEach(link => {
        link.addEventListener('click', () => {
            const targetTab = link.getAttribute('data-tab');
            navLinks.forEach(l => l.classList.remove('active'));
            link.classList.add('active');
            tabContents.forEach(content => {
                content.classList.remove('active');
                if (content.id === targetTab) content.classList.add('active');
            });
            syncAllViews(currentRegion);
            if (targetTab === 'risk') setTimeout(() => map.invalidateSize(), 400);
        });
    });

    globalSelector.addEventListener('change', (e) => {
        currentRegion = e.target.value;
        syncAllViews(currentRegion);
    });

    function syncAllViews(region) {
        const activeTab = document.querySelector('.nav-links li.active').getAttribute('data-tab');
        if (activeTab === 'risk') updateRiskOverviewUI(region);
        else if (activeTab === 'analytics') loadAnalyticsData();
        else if (activeTab === 'broadcast') loadBroadcasts();
    }

    // --- Number Animation Logic ---
    function animateValue(el, start, end, duration) {
        if (!el) return;
        let startTimestamp = null;
        const step = (timestamp) => {
            if (!startTimestamp) startTimestamp = timestamp;
            const progress = Math.min((timestamp - startTimestamp) / duration, 1);
            const currentVal = (progress * (end - start)) + start;
            el.innerHTML = el.classList.contains('counter') && el.innerHTML.includes('%') ?
                          `${currentVal.toFixed(1)}%` : Math.floor(currentVal).toString().padStart(2, '0');
            if (progress < 1) window.requestAnimationFrame(step);
        };
        window.requestAnimationFrame(step);
    }

    // --- Operational Dashboard Logic ---
    async function initSystem() {
        try {
            // Automatic Sync on load
            const statusIndicator = document.querySelector('.status-indicator span');
            if (statusIndicator) statusIndicator.textContent = 'SYSTEM SYNCING...';
            
            try {
                await fetch(`${API_BASE}/sync`, { method: 'POST' });
            } catch (syncErr) {
                console.warn('Initial sync failed, using cached data.', syncErr);
            }
            
            if (statusIndicator) statusIndicator.textContent = 'SYSTEM SYNC ACTIVE';

            const [preds, reads, alerts] = await Promise.all([
                fetch(`${API_BASE}/predictions`).then(res => res.json()),
                fetch(`${API_BASE}/readings`).then(res => res.json()),
                fetch(`${API_BASE}/alerts`).then(res => res.json())
            ]);
            latestPredictions = preds;
            latestReadings = reads;
            latestAlerts = alerts;

            if (latestPredictions.length > 0) {
                renderKPIs(currentRegion);
                plotGeospatialRisk();
                syncAllViews(currentRegion);
            }
        } catch (e) { 
            console.error('System Offline:', e); 
            const statusIndicator = document.querySelector('.status-indicator span');
            if (statusIndicator) statusIndicator.textContent = 'SYSTEM OFFLINE';
        }
    }

    // --- Realtime Auto-Refresh (Every 60s) ---
    setInterval(async () => {
        try {
            const [preds, reads, alerts] = await Promise.all([
                fetch(`${API_BASE}/predictions`).then(res => res.json()),
                fetch(`${API_BASE}/readings`).then(res => res.json()),
                fetch(`${API_BASE}/alerts`).then(res => res.json())
            ]);
            latestPredictions = preds;
            latestReadings = reads;
            latestAlerts = alerts;
            
            renderKPIs(currentRegion);
            plotGeospatialRisk();
            syncAllViews(currentRegion);
        } catch (e) { console.warn('Background Refresh Failed'); }
    }, 60000);

    function renderKPIs(regionName = "All") {
        const kpis = document.querySelectorAll('.kpi-value');
        const labels = document.querySelectorAll('.kpi-label');
        const metas = document.querySelectorAll('.kpi-meta');

        if (regionName === "All") {
            const top = [...latestPredictions].sort((a, b) => b.final_probability - a.final_probability)[0];
            const avg = (latestPredictions.reduce((acc, p) => acc + p.final_probability, 0) / latestPredictions.length) * 100;
            
            labels[0].textContent = "National Prob. Index";
            animateValue(kpis[0], 0, avg, 1000);
            
            labels[1].textContent = "Active Threat Vectors";
            animateValue(kpis[1], 0, latestPredictions.filter(p => p.risk_level !== 'Low').length, 1000);
            
            labels[2].textContent = "Peak Sector Risk";
            animateValue(kpis[2], 0, top.final_probability * 100, 1000);
            document.getElementById('topRiskRegion').textContent = `${top.region} (${top.risk_level})`;
            
            labels[3].textContent = "Automated Broadcasts";
            animateValue(kpis[3], 0, latestAlerts.length, 1000);
        } else {
            const p = latestPredictions.find(d => d.region === regionName);
            const r_alerts = latestAlerts.filter(a => a.region === regionName);
            
            labels[0].textContent = "Regional Prob. Index";
            animateValue(kpis[0], 0, p ? p.final_probability * 100 : 0, 1000);
            
            labels[1].textContent = "Regional Threats";
            animateValue(kpis[1], 0, p && p.risk_level !== 'Low' ? 1 : 0, 1000);
            
            labels[2].textContent = "Sector Risk Level";
            animateValue(kpis[2], 0, p ? p.final_probability * 100 : 0, 1000);
            document.getElementById('topRiskRegion').textContent = p ? `${p.region} (${p.risk_level})` : 'Unknown';
            
            labels[3].textContent = "Sector Broadcasts";
            animateValue(kpis[3], 0, r_alerts.length, 1000);
        }
    }

    function plotGeospatialRisk() {
        markersLayer.clearLayers();
        latestPredictions.forEach(p => {
            const coords = REGIONS_DATA[p.region];
            if (coords) {
                const color = p.risk_level === 'High' ? '#ef4444' : (p.risk_level === 'Moderate' ? '#f59e0b' : '#10b981');
                const radius = (p.final_probability * 25) + 6;

                const circle = L.circleMarker([coords.lat, coords.lon], {
                    radius: radius,
                    fillColor: color,
                    color: 'rgba(0,0,0,0.1)',
                    weight: 2,
                    opacity: 1,
                    fillOpacity: 0.75
                }).addTo(markersLayer);

                circle.bindPopup(`
                    <div style="text-align:center; font-family:'Space Mono',monospace; font-size:0.75rem;">
                        <b style="font-family:'Plus Jakarta Sans',sans-serif; font-size:0.9rem; display:block; margin-bottom:4px;">${p.region}</b>
                        <span style="color:#2563eb;">${(p.final_probability * 100).toFixed(1)}% Risk Prob.</span>
                    </div>
                `);
                circle.on('click', () => { currentRegion = p.region; globalSelector.value = p.region; syncAllViews(p.region); });
            }
        });
    }

    function updateRiskOverviewUI(regionName) {
        const title = document.getElementById('telemetryRegionName');
        const list = document.getElementById('indicatorList');
        const banner = document.getElementById('riskBanner');
        const bannerText = document.getElementById('bannerText');

        title.textContent = regionName.toUpperCase();
        renderKPIs(regionName);

        if (regionName === "All") {
            const avgSST = latestReadings.reduce((acc, r) => acc + r.sst, 0) / latestReadings.length;
            const avgWind = latestReadings.reduce((acc, r) => acc + r.wind_speed, 0) / latestReadings.length;
            const avgPress = latestReadings.reduce((acc, r) => acc + r.pressure, 0) / latestReadings.length;
            const avgRain = latestReadings.reduce((acc, r) => acc + r.rainfall, 0) / latestReadings.length;

            list.innerHTML = `
                <div class="telemetry-row"><span>SST (Satellite Avg)</span><strong>${avgSST.toFixed(3)} °C</strong></div>
                <div class="telemetry-row"><span>Wind Intensity Avg</span><strong>${avgWind.toFixed(3)} kn</strong></div>
                <div class="telemetry-row"><span>Atm. Pressure Avg</span><strong>${avgPress.toFixed(3)} hPa</strong></div>
                <div class="telemetry-row"><span>Rain Accumulation Avg</span><strong>${avgRain.toFixed(3)} mm</strong></div>
            `;
            map.flyTo([18, 82], 5);
            bannerText.textContent = "Global surveillance active. Monitoring multi-source satellite arrays.";
        } else {
            const r = latestReadings.find(d => d.region === regionName);
            const p = latestPredictions.find(d => d.region === regionName);
            if (r) {
                list.innerHTML = `
                    <div class="telemetry-row"><span>SST (Satellite)</span><strong>${r.sst.toFixed(3)} °C</strong></div>
                    <div class="telemetry-row"><span>Wind Intensity</span><strong>${r.wind_speed.toFixed(3)} kn</strong></div>
                    <div class="telemetry-row"><span>Atm. Pressure</span><strong>${r.pressure.toFixed(3)} hPa</strong></div>
                    <div class="telemetry-row"><span>Rain Accumulation</span><strong>${r.rainfall.toFixed(3)} mm</strong></div>
                `;
            }
            if (p) {
                banner.className = `global-advisory-banner ${p.risk_level.toLowerCase()}`;
                bannerText.innerHTML = `ADVISORY: <strong>${p.region.toUpperCase()}</strong> sector currently under <strong>${p.risk_level.toUpperCase()}</strong> risk surveillance.`;
            }
            map.flyTo([REGIONS_DATA[regionName].lat, REGIONS_DATA[regionName].lon], 7);
        }
    }

    // --- Deep Analytics Engine ---
    async function loadAnalyticsData() {
        const region = currentRegion;
        const displayLabel = region === "All" ? "National Overview" : region;
        document.getElementById('analyticsRegionName').textContent = displayLabel;

        try {
            const history = await fetch(`${API_BASE}/history/${encodeURIComponent(region)}`).then(res => res.json());
            if (history.length > 0) {
                renderIntelligenceCharts(history, displayLabel);
                generateInsights(history, displayLabel);
            }
        } catch (e) { console.error('Analytics Fetch Error:', e); }
    }

    function generateInsights(data, region) {
        const peak = Math.max(...data.map(d => d.final_probability)) * 100;
        const latestP = data[data.length - 1].raw_pressure;
        const avgP = data.reduce((acc, d) => acc + d.raw_pressure, 0) / data.length;
        const dev = (latestP - avgP).toFixed(1);

        document.getElementById('histPeakRisk').textContent = `${peak.toFixed(1)}%`;
        document.getElementById('pressureValue').textContent = `${latestP.toFixed(1)} hPa`;
        document.getElementById('windIntensity').textContent = `${Math.max(...data.map(d => d.raw_wind)).toFixed(1)} kn`;

        document.getElementById('intelligenceSummary').innerHTML =
            `Analysis for <strong>${region}</strong>: Current pressure deviation of ${dev} hPa against a 30-day peak risk of ${peak.toFixed(1)}%
            suggests a ${peak > 40 ? 'highly unstable' : 'nominal'} atmospheric state. Monitoring continues.`;
    }

    // --- Broadcast Engine ---
    async function loadBroadcasts() {
        document.getElementById('broadcastRegionName').textContent = currentRegion;
        latestAlerts = await fetch(`${API_BASE}/alerts`).then(res => res.json());
        renderAlertGrid();
    }

    function renderAlertGrid() {
        const grid = document.getElementById('alertContainer');
        let filtered = latestAlerts;
        if (currentRegion !== "All") filtered = filtered.filter(a => a.region === currentRegion);
        if (currentSeverityFilter !== "all") filtered = filtered.filter(a => a.severity === (currentSeverityFilter === 'high' ? 'High' : 'Moderate'));

        if (filtered.length === 0) {
            grid.innerHTML = `<div class="broadcast-empty">No ${currentSeverityFilter} alerts active for this sector.</div>`;
            return;
        }

        grid.innerHTML = filtered.map(a => `
            <div class="broadcast-card ${a.severity.toLowerCase()} animate-reveal">
                <span class="severity-tag">${a.severity}</span>
                <h4>${a.alert_type}</h4>
                <p>${a.message}</p>
                <div class="card-footer">
                    <span>📍 ${a.region}</span>
                    <span>🕒 ${new Date(a.timestamp).toLocaleTimeString()}</span>
                </div>
            </div>
        `).join('');
    }

    // Pill Filtering
    document.querySelectorAll('.pill').forEach(pill => {
        pill.addEventListener('click', () => {
            document.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            currentSeverityFilter = pill.getAttribute('data-severity');
            renderAlertGrid();
        });
    });

    // --- Charts (Dark Theme Config) ---
    let probChart, corrChart;
    function renderIntelligenceCharts(data, region) {
        if (probChart) probChart.destroy();
        if (corrChart) corrChart.destroy();

        const labels = data.map(d => new Date(d.timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));

        const getGradient = (ctx, colorStop) => {
            const gradient = ctx.createLinearGradient(0, 0, 0, 280);
            gradient.addColorStop(0, colorStop);
            gradient.addColorStop(1, 'rgba(0,0,0,0)');
            return gradient;
        };

        const chartDefaults = {
            responsive: true,
            maintainAspectRatio: false,
            layout: { padding: { top: 30, bottom: 10, left: 20, right: 20 } },
            interaction: { intersect: false, mode: 'index' },
            plugins: {
                legend: {
                    display: true, position: 'top', align: 'end',
                    labels: {
                        usePointStyle: true, pointStyle: 'rectRounded', padding: 30,
                        font: { size: 12, weight: '700', family: "'JetBrains Mono'" },
                        color: '#94a3b8'
                    }
                },
                annotation: {
                    annotations: {
                        low: { type: 'box', yMin: 0, yMax: 25, backgroundColor: 'rgba(34, 197, 94, 0.03)', borderWidth: 0 },
                        mod: { type: 'box', yMin: 25, yMax: 50, backgroundColor: 'rgba(234, 179, 8, 0.03)', borderWidth: 0 },
                        high: { type: 'box', yMin: 50, yMax: 100, backgroundColor: 'rgba(239, 68, 68, 0.03)', borderWidth: 0 }
                    }
                },
                tooltip: {
                    backgroundColor: 'rgba(6, 13, 31, 0.98)',
                    titleColor: '#ffffff', bodyColor: '#94a3b8',
                    titleFont: { size: 14, weight: '800', family: "'JetBrains Mono'" },
                    bodyFont: { size: 12, family: "'JetBrains Mono'" },
                    padding: 18, cornerRadius: 15,
                    borderColor: 'rgba(255, 255, 255, 0.1)', borderWidth: 1,
                    displayColors: true, boxPadding: 10,
                    callbacks: {
                        label: function(context) {
                            let label = ` ${context.dataset.label}: `;
                            label += context.parsed.y;
                            if (context.dataset.label.includes('Risk')) {
                                const val = context.parsed.y;
                                label += val > 50 ? ' [ ALERT ]' : (val > 25 ? ' [ WARN ]' : ' [ OK ]');
                            }
                            return label;
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: { display: true, color: 'rgba(255,255,255,0.02)', drawTicks: false },
                    ticks: { color: '#475569', font: { size: 10, family: "'JetBrains Mono'" }, padding: 15 },
                    border: { display: false }
                },
                y: {
                    grid: { color: 'rgba(255,255,255,0.02)', drawBorder: false },
                    ticks: { color: '#475569', font: { size: 10, family: "'JetBrains Mono'" }, padding: 15 },
                    border: { display: false }
                }
            }
        };

        const ctx1 = document.getElementById('probabilityChart').getContext('2d');
        probChart = new Chart(ctx1, {
            type: 'line',
            data: {
                labels,
                datasets: [{
                    label: 'Risk Index (%)',
                    data: data.map(d => (d.final_probability * 100).toFixed(1)),
                    borderColor: '#ff7e00',
                    borderWidth: 4,
                    shadowBlur: 25, shadowColor: 'rgba(255, 126, 0, 0.6)',
                    backgroundColor: getGradient(ctx1, 'rgba(255, 126, 0, 0.15)'),
                    fill: true,
                    tension: 0.4,
                    pointRadius: 0,
                    pointHoverRadius: 8,
                    pointHoverBackgroundColor: '#ffffff',
                    pointHoverBorderWidth: 4
                }]
            },
            options: chartDefaults
        });

        const ctx2 = document.getElementById('correlationChart').getContext('2d');
        corrChart = new Chart(ctx2, {
            type: 'line',
            data: {
                labels,
                datasets: [
                    {
                        label: 'Risk Index (%)',
                        data: data.map(d => (d.final_probability * 100).toFixed(1)),
                        borderColor: '#ff7e00',
                        borderWidth: 4,
                        shadowBlur: 15, shadowColor: 'rgba(255, 126, 0, 0.5)',
                        backgroundColor: getGradient(ctx2, 'rgba(255, 126, 0, 0.1)'),
                        fill: true,
                        tension: 0.4,
                        pointRadius: 0,
                        pointHoverRadius: 7,
                        yAxisID: 'y'
                    },
                    {
                        label: 'SST Intensity (°C)',
                        data: data.map(d => d.raw_sst.toFixed(1)),
                        borderColor: '#00d2ff',
                        borderWidth: 4,
                        borderDash: [10, 5],
                        shadowBlur: 15, shadowColor: 'rgba(0, 210, 255, 0.5)',
                        backgroundColor: getGradient(ctx2, 'rgba(0, 210, 255, 0.05)'),
                        fill: true,
                        tension: 0.4,
                        pointRadius: 0,
                        pointHoverRadius: 7,
                        yAxisID: 'y1'
                    }
                ]
            },
            options: {
                ...chartDefaults,
                scales: {
                    x: chartDefaults.scales.x,
                    y: {
                        ...chartDefaults.scales.y,
                        position: 'left',
                        title: { display: true, text: 'Risk Index (%)', font: { size: 12, weight: '700' }, color: '#f97316' },
                        suggestedMax: 100
                    },
                    y1: {
                        type: 'linear',
                        position: 'right',
                        grid: { drawOnChartArea: false },
                        ticks: { color: '#3b82f6', font: { size: 10, weight: '700' } },
                        border: { display: false },
                        title: { display: true, text: 'Sea Surface Temp (°C)', font: { size: 12, weight: '700' }, color: '#3b82f6' }
                    }
                }
            }
        });
    }



    initSystem();
});