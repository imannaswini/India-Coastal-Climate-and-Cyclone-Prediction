document.addEventListener('DOMContentLoaded', () => {
    const API_BASE = (() => {
        if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
            const host = window.location.hostname || 'localhost';
            return `${window.location.protocol}//${host}:8000`;
        }
        return 'http://localhost:8000';
    })();

    const REFRESH_INTERVAL_MS = 15000;
    const SYNC_INTERVAL_MS = 60000;

    const preloader = document.getElementById('preloader');
    const navLinks = document.querySelectorAll('.nav-links li');
    const tabContents = document.querySelectorAll('.tab-content');
    const globalSelector = document.getElementById('stateSelect');
    const statusIndicator = document.getElementById('systemStatusText');
    const apiLinkStatus = document.getElementById('apiLinkStatus');
    const lastRefreshStatus = document.getElementById('lastRefreshStatus');
    const pipelineRunStatus = document.getElementById('pipelineRunStatus');
    const pipelineDurationStatus = document.getElementById('pipelineDurationStatus');
    const pulseDot = document.getElementById('systemPulse');

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

    let latestPredictions = [];
    let latestReadings = [];
    let latestAlerts = [];
    let latestLog = null;
    let currentRegion = 'All';
    let currentAlertTypeFilter = 'all';
    let isRefreshing = false;
    let historyRequestId = 0;
    let lastSyncAt = null;
    let historyCache = [];
    let mainChart;
    let weatherChart;
    let pressureSpark;
    let tempSpark;
    let windSpark;

    const lightTiles = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; CARTO'
    });

    const satelliteTiles = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Esri'
    });

    const map = L.map('map', {
        center: [18, 82],
        zoom: 5,
        layers: [lightTiles],
        zoomControl: false,
        attributionControl: false
    });

    L.control.zoom({ position: 'topright' }).addTo(map);
    const markersLayer = L.layerGroup().addTo(map);

    function hidePreloader() {
        if (!preloader) return;
        preloader.style.opacity = '0';
        setTimeout(() => {
            preloader.style.display = 'none';
        }, 600);
    }

    setTimeout(hidePreloader, 2800);
    window.addEventListener('load', hidePreloader);

    function toNumber(value, fallback = 0) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function average(values, fallback = 0) {
        const valid = values.map((value) => toNumber(value, NaN)).filter(Number.isFinite);
        if (!valid.length) return fallback;
        return valid.reduce((sum, value) => sum + value, 0) / valid.length;
    }

    function formatDateTime(value) {
        if (!value) return '--';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '--';
        return date.toLocaleString();
    }

    function formatDuration(seconds) {
        const value = toNumber(seconds, NaN);
        return Number.isFinite(value) ? `${value.toFixed(1)}s` : '--';
    }

    function historySampleLabel(count) {
        return count === 1 ? '1 live sample' : `${count} live samples`;
    }

    function normalizeSeverity(severity) {
        const raw = String(severity || '').toUpperCase();
        if (raw === 'CRITICAL' || raw === 'HIGH') {
            return { label: 'Critical', className: 'high', filterKey: 'high' };
        }
        if (raw === 'WARNING' || raw === 'MODERATE') {
            return { label: 'Advisory', className: 'moderate', filterKey: 'moderate' };
        }
        return { label: raw || 'Info', className: 'low', filterKey: 'all' };
    }

    function getAlertCategory(alertType) {
        const raw = String(alertType || '').toLowerCase();
        if (raw.includes('cyclone')) {
            return { key: 'cyclone', label: 'Cyclone' };
        }
        if (raw.includes('pressure')) {
            return { key: 'pressure', label: 'Pressure' };
        }
        if (raw.includes('wind')) {
            return { key: 'wind', label: 'Wind' };
        }
        if (raw.includes('rain')) {
            return { key: 'rain', label: 'Rain' };
        }
        return { key: 'other', label: 'General' };
    }

    function getAlertRiskBand(alert) {
        const prediction = getPrediction(alert.region);
        const riskLevel = String(prediction?.risk_level || '').toLowerCase();
        if (riskLevel === 'high' || riskLevel === 'moderate' || riskLevel === 'low') {
            return {
                key: riskLevel,
                label: `${riskLevel.charAt(0).toUpperCase()}${riskLevel.slice(1)} Risk`
            };
        }

        const probability = toNumber(prediction?.final_probability) * 100;
        if (probability >= 55) {
            return { key: 'high', label: 'High Risk' };
        }
        if (probability >= 25) {
            return { key: 'moderate', label: 'Moderate Risk' };
        }
        return { key: 'low', label: 'Low Risk' };
    }

    function setStatus(text, tone = 'online') {
        statusIndicator.textContent = text;
        pulseDot.style.background =
            tone === 'error' ? 'var(--red)' :
            tone === 'busy' ? 'var(--yellow)' :
            'var(--green)';
    }

    function setMetaStatus() {
        apiLinkStatus.textContent = latestPredictions.length || latestReadings.length || latestAlerts.length ? 'Connected' : 'Waiting';
        lastRefreshStatus.textContent = lastSyncAt ? formatDateTime(lastSyncAt) : '--';
        pipelineRunStatus.textContent = latestLog?.run_timestamp ? formatDateTime(latestLog.run_timestamp) : '--';
        pipelineDurationStatus.textContent = latestLog?.errors ? `Error: ${latestLog.errors}` : formatDuration(latestLog?.duration_seconds);
    }

    async function fetchJson(path, options = {}) {
        const response = await fetch(`${API_BASE}${path}`, {
            cache: 'no-store',
            ...options,
            headers: {
                'Cache-Control': 'no-cache',
                ...(options.headers || {})
            }
        });

        if (!response.ok) {
            throw new Error(`${path} failed with ${response.status}`);
        }

        return response.json();
    }

    async function runBackendSync() {
        try {
            setStatus('SYNCING BACKEND', 'busy');
            await fetchJson('/sync', { method: 'POST' });
            return true;
        } catch (error) {
            console.warn('Backend sync failed. Falling back to latest API data.', error);
            return false;
        }
    }

    async function fetchSnapshot() {
        const [predictions, readings, alerts, logs] = await Promise.all([
            fetchJson('/predictions'),
            fetchJson('/readings'),
            fetchJson('/alerts'),
            fetchJson('/logs').catch(() => null)
        ]);

        latestPredictions = Array.isArray(predictions) ? predictions : [];
        latestReadings = Array.isArray(readings) ? readings : [];
        latestAlerts = Array.isArray(alerts) ? alerts : [];
        latestLog = logs || null;
        lastSyncAt = new Date().toISOString();
        setMetaStatus();
    }

    function getPrediction(regionName) {
        return latestPredictions.find((item) => item.region === regionName) || null;
    }

    function getReading(regionName) {
        return latestReadings.find((item) => item.region === regionName) || null;
    }

    function getActiveTab() {
        return document.querySelector('.nav-links li.active')?.getAttribute('data-tab') || 'dashboard';
    }

    function animateValue(element, target, suffix = '', decimals = 0) {
        if (!element) return;
        const end = toNumber(target, 0);
        const duration = 650;
        const start = toNumber(element.dataset.value, 0);
        let startTime = null;

        const frame = (timestamp) => {
            if (!startTime) startTime = timestamp;
            const progress = Math.min((timestamp - startTime) / duration, 1);
            const current = start + ((end - start) * progress);
            element.textContent = `${current.toFixed(decimals)}${suffix}`;
            if (progress < 1) {
                requestAnimationFrame(frame);
            } else {
                element.dataset.value = String(end);
            }
        };

        requestAnimationFrame(frame);
    }

    function renderSummaryCards(regionName = 'All') {
        const cards = document.querySelectorAll('.summary-card .summary-value');
        const prediction = regionName === 'All'
            ? [...latestPredictions].sort((a, b) => toNumber(b.final_probability) - toNumber(a.final_probability))[0]
            : getPrediction(regionName);

        const reading = regionName === 'All'
            ? {
                sst: average(latestReadings.map((item) => item.sst), 0),
                pressure: average(latestReadings.map((item) => item.pressure), 0),
                wind_speed: average(latestReadings.map((item) => item.wind_speed), 0)
            }
            : getReading(regionName);

        animateValue(cards[0], toNumber(prediction?.final_probability) * 100, '%', 1);
        animateValue(cards[1], toNumber(reading?.sst), ' C', 1);
        animateValue(cards[2], toNumber(reading?.pressure), ' hPa', 0);
        animateValue(cards[3], toNumber(reading?.wind_speed), ' kn', 1);

        const topRiskRegion = document.getElementById('topRiskRegion');
        if (prediction) {
            topRiskRegion.textContent = `${prediction.region} · ${prediction.risk_level} risk`;
        } else {
            topRiskRegion.textContent = 'Waiting for live model output';
        }
    }

    function renderBanner(regionName = 'All') {
        const banner = document.getElementById('riskBanner');
        const bannerText = document.getElementById('bannerText');
        const prediction = regionName === 'All'
            ? [...latestPredictions].sort((a, b) => toNumber(b.final_probability) - toNumber(a.final_probability))[0]
            : getPrediction(regionName);

        banner.className = 'advisory-banner';

        if (!prediction) {
            bannerText.textContent = 'Connected to the backend and waiting for the latest forecast cycle.';
            return;
        }

        const levelClass = String(prediction.risk_level || 'Low').toLowerCase();
        banner.classList.add(levelClass);
        bannerText.innerHTML = `Current focus: <strong>${prediction.region}</strong> with <strong>${(toNumber(prediction.final_probability) * 100).toFixed(1)}%</strong> cyclone risk and <strong>${prediction.risk_level}</strong> status.`;
    }

    function renderTelemetry(regionName = 'All') {
        const container = document.getElementById('indicatorList');
        const title = document.getElementById('telemetryRegionName');
        title.textContent = regionName.toUpperCase();

        if (!latestReadings.length) {
            container.innerHTML = '<div class="telemetry-placeholder">Waiting for backend readings...</div>';
            return;
        }

        const metrics = regionName === 'All'
            ? {
                rainfall: average(latestReadings.map((item) => item.rainfall), 0),
                wind_speed: average(latestReadings.map((item) => item.wind_speed), 0),
                pressure: average(latestReadings.map((item) => item.pressure), 0),
                sst: average(latestReadings.map((item) => item.sst), 0)
            }
            : getReading(regionName);

        if (!metrics) {
            container.innerHTML = '<div class="telemetry-placeholder">No regional telemetry returned from the backend yet.</div>';
            return;
        }

        container.innerHTML = `
            <div class="telemetry-row"><span>Sea Surface Temperature</span><strong>${toNumber(metrics.sst).toFixed(2)} C</strong></div>
            <div class="telemetry-row"><span>Wind Speed</span><strong>${toNumber(metrics.wind_speed).toFixed(2)} kn</strong></div>
            <div class="telemetry-row"><span>Pressure</span><strong>${toNumber(metrics.pressure).toFixed(1)} hPa</strong></div>
            <div class="telemetry-row"><span>Rainfall</span><strong>${toNumber(metrics.rainfall).toFixed(2)} mm</strong></div>
        `;
    }

    function renderAlertCards(targetId, alerts) {
        const container = document.getElementById(targetId);
        if (!container) return;

        if (!alerts.length) {
            container.innerHTML = '<div class="alert-empty">No active alerts for the current selection.</div>';
            return;
        }

        container.innerHTML = alerts.map((alert) => {
            const severity = normalizeSeverity(alert.severity);
            const category = getAlertCategory(alert.alert_type);
            const riskBand = getAlertRiskBand(alert);
            const riskValue = toNumber(alert.final_probability ?? getPrediction(alert.region)?.final_probability) * 100;
            return `
                <article class="alert-card ${severity.className}">
                    <div class="alert-chip-row">
                        <span class="severity-tag">${severity.label}</span>
                        <span class="category-tag">${category.label}</span>
                        <span class="risk-tag ${riskBand.key}">${riskBand.label}</span>
                    </div>
                    <h4>${alert.alert_type || 'Operational Alert'}</h4>
                    <p>${alert.message || 'No alert message provided.'}</p>
                    <div class="card-footer">
                        <span>${alert.region || 'Unknown region'}</span>
                        <span>${formatDateTime(alert.timestamp)}</span>
                        <span>${riskValue ? `${riskValue.toFixed(1)}% risk` : 'Risk pending'}</span>
                    </div>
                </article>
            `;
        }).join('');
    }

    function renderAlerts(regionName = 'All') {
        let filtered = latestAlerts.slice();

        if (regionName !== 'All') {
            filtered = filtered.filter((alert) => alert.region === regionName);
        }

        if (currentAlertTypeFilter !== 'all') {
            filtered = filtered.filter((alert) => getAlertCategory(alert.alert_type).key === currentAlertTypeFilter);
        }

        document.getElementById('broadcastRegionName').textContent = regionName === 'All' ? 'All Sectors' : regionName;
        renderAlertCards('alertContainer', filtered);
        renderAlertCards('alertsOverview', filtered);
    }

    function plotGeospatialRisk() {
        markersLayer.clearLayers();

        latestPredictions.forEach((prediction) => {
            const coords = REGIONS_DATA[prediction.region];
            if (!coords) return;

            const probability = toNumber(prediction.final_probability) * 100;
            const riskLevel = String(prediction.risk_level || 'Low');
            const color = riskLevel === 'High' ? '#ef4444' : (riskLevel === 'Moderate' ? '#f59e0b' : '#22c55e');
            const marker = L.circleMarker([coords.lat, coords.lon], {
                radius: 8 + (probability / 18),
                fillColor: color,
                color: '#ffffff',
                weight: 2,
                opacity: 1,
                fillOpacity: 0.85
            }).addTo(markersLayer);

            marker.bindPopup(`
                <div style="font-family:Inter,sans-serif; min-width:190px;">
                    <strong style="display:block; margin-bottom:6px;">${prediction.region}</strong>
                    <div>Risk: ${(probability).toFixed(1)}%</div>
                    <div>Status: ${prediction.risk_level}</div>
                    <div>SST: ${toNumber(getReading(prediction.region)?.sst).toFixed(2)} C</div>
                </div>
            `);

            marker.on('click', () => {
                currentRegion = prediction.region;
                globalSelector.value = prediction.region;
                renderCurrentView();
            });
        });

        const targetCoords = REGIONS_DATA[currentRegion] || REGIONS_DATA.All;
        map.flyTo([targetCoords.lat, targetCoords.lon], targetCoords.zoom, { duration: 0.8 });
    }

    function buildGlassTooltip(pressureValues) {
        return {
            backgroundColor: 'rgba(255, 255, 255, 0.78)',
            borderColor: 'rgba(82, 130, 183, 0.24)',
            borderWidth: 1,
            titleColor: '#14324f',
            bodyColor: '#36587a',
            padding: 14,
            cornerRadius: 16,
            displayColors: true,
            boxPadding: 6,
            titleFont: { family: 'Poppins', size: 13, weight: '700' },
            bodyFont: { family: 'Inter', size: 12, weight: '600' },
            callbacks: {
                label(context) {
                    const index = context.dataIndex;
                    const risk = context.chart.data.datasets[0]?.data?.[index];
                    const sst = context.chart.data.datasets[1]?.data?.[index];
                    const pressure = pressureValues[index];

                    if (context.datasetIndex !== 0) return null;

                    return [
                        `Risk: ${toNumber(risk).toFixed(1)}%`,
                        `SST: ${toNumber(sst).toFixed(2)} C`,
                        `Pressure: ${toNumber(pressure).toFixed(1)} hPa`
                    ];
                }
            }
        };
    }

    function buildGradient(ctx, area, startColor, endColor) {
        const gradient = ctx.createLinearGradient(0, area.top, 0, area.bottom);
        gradient.addColorStop(0, startColor);
        gradient.addColorStop(1, endColor);
        return gradient;
    }

    function createRiskChart(history) {
        if (mainChart) mainChart.destroy();

        const labels = history.map((item) => {
            const date = new Date(item.timestamp);
            return Number.isNaN(date.getTime())
                ? '--'
                : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        });

        const riskData = history.map((item) => toNumber(item.final_probability) * 100);
        const sstData = history.map((item) => toNumber(item.raw_sst, NaN));
        const pressureData = history.map((item) => toNumber(item.raw_pressure, NaN));
        const singlePoint = history.length === 1;
        const maxRisk = riskData.length ? Math.max(...riskData) : 0;
        const peakIndexes = riskData
            .map((value, index) => ({ value, index }))
            .filter((point) => point.value >= Math.max(55, maxRisk * 0.85))
            .map((point) => point.index);

        const chartCtx = document.getElementById('probabilityChart').getContext('2d');

        mainChart = new Chart(chartCtx, {
            type: 'line',
            data: {
                labels,
                datasets: [
                    {
                        label: 'Cyclone Risk (%)',
                        data: riskData,
                        yAxisID: 'y',
                        borderColor: '#ef4444',
                        borderWidth: 3.5,
                        tension: 0.4,
                        spanGaps: true,
                        pointRadius(context) {
                            return singlePoint || peakIndexes.includes(context.dataIndex) ? 5 : 0;
                        },
                        pointHoverRadius: 6,
                        pointBackgroundColor: '#ef4444',
                        pointBorderColor: '#ffffff',
                        pointBorderWidth: 2,
                        fill: true,
                        backgroundColor(context) {
                            const { chart } = context;
                            const { ctx, chartArea } = chart;
                            if (!chartArea) return 'rgba(239, 68, 68, 0.14)';
                            return buildGradient(ctx, chartArea, 'rgba(239, 68, 68, 0.22)', 'rgba(239, 68, 68, 0.02)');
                        }
                    },
                    {
                        label: 'Sea Surface Temperature (C)',
                        data: sstData,
                        yAxisID: 'y1',
                        borderColor: '#198fdc',
                        borderWidth: 3,
                        tension: 0.4,
                        spanGaps: true,
                        pointRadius(context) {
                            return singlePoint || peakIndexes.includes(context.dataIndex) ? 4 : 0;
                        },
                        pointHoverRadius: 5,
                        pointBackgroundColor: '#198fdc',
                        pointBorderColor: '#ffffff',
                        pointBorderWidth: 2,
                        fill: true,
                        backgroundColor(context) {
                            const { chart } = context;
                            const { ctx, chartArea } = chart;
                            if (!chartArea) return 'rgba(25, 143, 220, 0.14)';
                            return buildGradient(ctx, chartArea, 'rgba(25, 143, 220, 0.18)', 'rgba(25, 143, 220, 0.02)');
                        }
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: {
                    duration: 1100,
                    easing: 'easeOutQuart'
                },
                interaction: {
                    mode: 'index',
                    intersect: false
                },
                plugins: {
                    legend: {
                        position: 'top',
                        align: 'start',
                        labels: {
                            usePointStyle: true,
                            pointStyle: 'circle',
                            color: '#36587a',
                            font: { family: 'Inter', size: 12, weight: '700' },
                            padding: 20
                        }
                    },
                    tooltip: buildGlassTooltip(pressureData),
                    annotation: {
                        annotations: {
                            lowZone: {
                                type: 'box',
                                yMin: 0,
                                yMax: 25,
                                backgroundColor: 'rgba(34, 197, 94, 0.08)',
                                borderWidth: 0
                            },
                            advisoryZone: {
                                type: 'box',
                                yMin: 25,
                                yMax: 55,
                                backgroundColor: 'rgba(245, 158, 11, 0.08)',
                                borderWidth: 0
                            },
                            criticalZone: {
                                type: 'box',
                                yMin: 55,
                                yMax: 100,
                                backgroundColor: 'rgba(239, 68, 68, 0.08)',
                                borderWidth: 0
                            },
                            ...Object.fromEntries(peakIndexes.map((index) => [
                                `riskPeak${index}`,
                                {
                                    type: 'label',
                                    xValue: labels[index],
                                    yValue: riskData[index],
                                    backgroundColor: 'rgba(239, 68, 68, 0.92)',
                                    color: '#ffffff',
                                    content: [`Peak ${riskData[index].toFixed(0)}%`],
                                    font: { family: 'Inter', size: 11, weight: '700' },
                                    padding: 6,
                                    borderRadius: 10,
                                    yAdjust: -22
                                }
                            ]))
                        }
                    }
                },
                scales: {
                    x: {
                        grid: { display: false },
                        ticks: {
                            color: '#6b8aac',
                            font: { family: 'Inter', size: 11, weight: '600' }
                        }
                    },
                    y: {
                        position: 'left',
                        min: 0,
                        max: 100,
                        title: {
                            display: true,
                            text: 'Cyclone Risk (%)',
                            color: '#c43737',
                            font: { family: 'Poppins', size: 12, weight: '700' }
                        },
                        ticks: {
                            color: '#6b8aac',
                            callback(value) {
                                return `${value}%`;
                            }
                        },
                        grid: {
                            color: 'rgba(112, 150, 193, 0.14)'
                        }
                    },
                    y1: {
                        position: 'right',
                        title: {
                            display: true,
                            text: 'Sea Surface Temperature (C)',
                            color: '#198fdc',
                            font: { family: 'Poppins', size: 12, weight: '700' }
                        },
                        ticks: {
                            color: '#6b8aac'
                        },
                        grid: {
                            drawOnChartArea: false
                        }
                    }
                }
            },
            plugins: [{
                id: 'lineGlow',
                beforeDatasetDraw(chart) {
                    const { ctx } = chart;
                    ctx.save();
                    ctx.shadowColor = 'rgba(25, 143, 220, 0.22)';
                    ctx.shadowBlur = 18;
                    ctx.shadowOffsetY = 8;
                },
                afterDatasetDraw(chart) {
                    chart.ctx.restore();
                }
            }]
        });
    }

    function createWeatherChart(history) {
        if (weatherChart) weatherChart.destroy();

        const labels = history.map((item) => {
            const date = new Date(item.timestamp);
            return Number.isNaN(date.getTime())
                ? '--'
                : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        });

        const pressureData = history.map((item) => toNumber(item.raw_pressure, NaN));
        const sstData = history.map((item) => toNumber(item.raw_sst, NaN));
        const windData = history.map((item) => toNumber(item.raw_wind, NaN));
        const singlePoint = history.length === 1;

        const chartCtx = document.getElementById('correlationChart').getContext('2d');

        weatherChart = new Chart(chartCtx, {
            type: 'line',
            data: {
                labels,
                datasets: [
                    {
                        label: 'Pressure',
                        data: pressureData,
                        borderColor: '#f59e0b',
                        borderWidth: 2.5,
                        tension: 0.4,
                        spanGaps: true,
                        pointRadius: singlePoint ? 4 : 0,
                        pointHoverRadius: 5,
                        pointBackgroundColor: '#f59e0b'
                    },
                    {
                        label: 'Temperature',
                        data: sstData,
                        borderColor: '#14b8a6',
                        borderWidth: 2.5,
                        tension: 0.4,
                        spanGaps: true,
                        pointRadius: singlePoint ? 4 : 0,
                        pointHoverRadius: 5,
                        pointBackgroundColor: '#14b8a6'
                    },
                    {
                        label: 'Wind Speed',
                        data: windData,
                        borderColor: '#8b5cf6',
                        borderWidth: 2.5,
                        tension: 0.4,
                        spanGaps: true,
                        pointRadius: singlePoint ? 4 : 0,
                        pointHoverRadius: 5,
                        pointBackgroundColor: '#8b5cf6'
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: {
                    duration: 900,
                    easing: 'easeOutQuart'
                },
                plugins: {
                    legend: {
                        position: 'top',
                        align: 'start',
                        labels: {
                            usePointStyle: true,
                            pointStyle: 'line',
                            color: '#36587a',
                            font: { family: 'Inter', size: 12, weight: '700' },
                            padding: 18
                        }
                    },
                    tooltip: {
                        backgroundColor: 'rgba(255, 255, 255, 0.78)',
                        borderColor: 'rgba(82, 130, 183, 0.24)',
                        borderWidth: 1,
                        titleColor: '#14324f',
                        bodyColor: '#36587a',
                        padding: 12,
                        cornerRadius: 14,
                        titleFont: { family: 'Poppins', size: 13, weight: '700' },
                        bodyFont: { family: 'Inter', size: 12, weight: '600' }
                    }
                },
                scales: {
                    x: {
                        grid: { display: false },
                        ticks: { color: '#6b8aac' }
                    },
                    y: {
                        grid: { color: 'rgba(112, 150, 193, 0.14)' },
                        ticks: { color: '#6b8aac' }
                    }
                }
            }
        });
    }

    function createSparkChart(canvasId, instance, data, color, fill) {
        if (instance) instance.destroy();

        const ctx = document.getElementById(canvasId).getContext('2d');
        const singlePoint = data.length === 1;
        return new Chart(ctx, {
            type: 'line',
            data: {
                labels: data.map((_, index) => index + 1),
                datasets: [{
                    data,
                    borderColor: color,
                    borderWidth: 2.4,
                    tension: 0.4,
                    spanGaps: true,
                    pointRadius: singlePoint ? 4 : 0,
                    pointHoverRadius: 5,
                    pointBackgroundColor: color,
                    fill: true,
                    backgroundColor: fill
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: { enabled: false }
                },
                scales: {
                    x: { display: false },
                    y: { display: false }
                }
            }
        });
    }

    function renderHistoryWidgets(history) {
        const pressureData = history.map((item) => toNumber(item.raw_pressure, NaN));
        const tempData = history.map((item) => toNumber(item.raw_sst, NaN));
        const windData = history.map((item) => toNumber(item.raw_wind, NaN));

        pressureSpark = createSparkChart('pressureSpark', pressureSpark, pressureData, '#f59e0b', (context) => {
            const { chart } = context;
            const { ctx, chartArea } = chart;
            if (!chartArea) return 'rgba(245, 158, 11, 0.12)';
            return buildGradient(ctx, chartArea, 'rgba(245, 158, 11, 0.18)', 'rgba(245, 158, 11, 0.02)');
        });

        tempSpark = createSparkChart('tempSpark', tempSpark, tempData, '#14b8a6', (context) => {
            const { chart } = context;
            const { ctx, chartArea } = chart;
            if (!chartArea) return 'rgba(20, 184, 166, 0.12)';
            return buildGradient(ctx, chartArea, 'rgba(20, 184, 166, 0.18)', 'rgba(20, 184, 166, 0.02)');
        });

        windSpark = createSparkChart('windSpark', windSpark, windData, '#8b5cf6', (context) => {
            const { chart } = context;
            const { ctx, chartArea } = chart;
            if (!chartArea) return 'rgba(139, 92, 246, 0.12)';
            return buildGradient(ctx, chartArea, 'rgba(139, 92, 246, 0.18)', 'rgba(139, 92, 246, 0.02)');
        });
    }

    function clearHistoryWidgets() {
        const noDataText = 'No historical analytics are available for this region yet.';
        document.getElementById('histPeakRisk').textContent = '--';
        document.getElementById('pressureValue').textContent = '--';
        document.getElementById('windIntensity').textContent = '--';
        document.getElementById('intelligenceSummary').textContent = noDataText;

        if (mainChart) mainChart.destroy();
        if (weatherChart) weatherChart.destroy();
        if (pressureSpark) pressureSpark.destroy();
        if (tempSpark) tempSpark.destroy();
        if (windSpark) windSpark.destroy();
    }

    function renderInsightSummary(history, regionLabel) {
        const probabilities = history.map((item) => toNumber(item.final_probability, NaN)).filter(Number.isFinite);
        const pressures = history.map((item) => toNumber(item.raw_pressure, NaN)).filter(Number.isFinite);
        const winds = history.map((item) => toNumber(item.raw_wind, NaN)).filter(Number.isFinite);
        const sampleCount = history.length;
        const sampleNote = sampleCount < 2
            ? ' Only one live backend snapshot is available right now, so the charts show the current point rather than a full trend.'
            : ` Trend view is based on ${historySampleLabel(sampleCount)}.`;

        const peakRisk = probabilities.length ? Math.max(...probabilities) * 100 : 0;
        const latestPressure = pressures.length ? pressures[pressures.length - 1] : NaN;
        const latestWind = winds.length ? winds[winds.length - 1] : NaN;
        const pressureDeviation = Number.isFinite(latestPressure)
            ? latestPressure - average(pressures, latestPressure)
            : NaN;

        document.getElementById('histPeakRisk').textContent = `${peakRisk.toFixed(1)}%`;
        document.getElementById('pressureValue').textContent = Number.isFinite(latestPressure) ? `${latestPressure.toFixed(1)} hPa` : '--';
        document.getElementById('windIntensity').textContent = Number.isFinite(latestWind) ? `${latestWind.toFixed(1)} kn` : '--';

        document.getElementById('intelligenceSummary').innerHTML =
            `For <strong>${regionLabel}</strong>, the latest available series shows a peak cyclone risk of <strong>${peakRisk.toFixed(1)}%</strong>. Pressure is currently <strong>${Number.isFinite(latestPressure) ? latestPressure.toFixed(1) : '--'} hPa</strong> with a deviation of <strong>${Number.isFinite(pressureDeviation) ? pressureDeviation.toFixed(1) : '--'} hPa</strong> from the recent average.${sampleNote}`;
    }

    async function loadHistoryData(regionName = currentRegion) {
        const requestId = ++historyRequestId;
        const regionLabel = regionName === 'All' ? 'National Overview' : regionName;
        document.getElementById('analyticsRegionName').textContent = regionLabel;

        try {
            const history = await fetchJson(`/history/${encodeURIComponent(regionName)}`);
            if (requestId !== historyRequestId) return;

            historyCache = Array.isArray(history) ? history : [];

            if (!historyCache.length) {
                document.getElementById('analyticsRegionName').textContent = `${regionLabel} · No history`;
                clearHistoryWidgets();
                return;
            }

            document.getElementById('analyticsRegionName').textContent = `${regionLabel} · ${historySampleLabel(historyCache.length)}`;

            createRiskChart(historyCache);
            createWeatherChart(historyCache);
            renderHistoryWidgets(historyCache);
            renderInsightSummary(historyCache, regionLabel);
        } catch (error) {
            console.error('History fetch failed:', error);
            clearHistoryWidgets();
        }
    }

    function renderCurrentView() {
        renderSummaryCards(currentRegion);
        renderBanner(currentRegion);
        renderTelemetry(currentRegion);
        renderAlerts(currentRegion);
        plotGeospatialRisk();

        const activeTab = getActiveTab();
        if (activeTab === 'analytics' || activeTab === 'dashboard') {
            loadHistoryData(currentRegion);
        }
    }

    async function refreshDashboard({ triggerSync = false } = {}) {
        if (isRefreshing) return;
        isRefreshing = true;

        try {
            if (triggerSync) {
                await runBackendSync();
            } else {
                setStatus('REFRESHING DATA', 'busy');
            }

            await fetchSnapshot();
            renderCurrentView();
            setStatus(latestLog?.errors ? 'PIPELINE DEGRADED' : 'SYNC ACTIVE', latestLog?.errors ? 'busy' : 'online');
        } catch (error) {
            console.error('Dashboard refresh failed:', error);
            setStatus('SYSTEM OFFLINE', 'error');
            apiLinkStatus.textContent = 'Offline';
        } finally {
            isRefreshing = false;
        }
    }

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

    navLinks.forEach((link) => {
        link.addEventListener('click', () => {
            const target = link.getAttribute('data-tab');
            navLinks.forEach((item) => item.classList.remove('active'));
            link.classList.add('active');
            tabContents.forEach((content) => {
                content.classList.toggle('active', content.id === target);
            });
            renderCurrentView();
            if (target === 'dashboard') {
                setTimeout(() => map.invalidateSize(), 250);
            }
        });
    });

    globalSelector.addEventListener('change', (event) => {
        currentRegion = event.target.value;
        renderCurrentView();
    });

    document.querySelectorAll('.pill[data-alert-type]').forEach((pill) => {
        pill.addEventListener('click', () => {
            document.querySelectorAll('.pill[data-alert-type]').forEach((item) => item.classList.remove('active'));
            document.querySelectorAll(`.pill[data-alert-type="${pill.getAttribute('data-alert-type')}"]`).forEach((item) => item.classList.add('active'));
            currentAlertTypeFilter = pill.getAttribute('data-alert-type');
            renderAlerts(currentRegion);
        });
    });

    refreshDashboard({ triggerSync: true });

    setInterval(() => {
        refreshDashboard({ triggerSync: false });
    }, REFRESH_INTERVAL_MS);

    setInterval(() => {
        refreshDashboard({ triggerSync: true });
    }, SYNC_INTERVAL_MS);
});
