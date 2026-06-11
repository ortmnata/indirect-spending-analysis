// ==UserScript==
// @name         Indirect Spending Analysis
// @namespace    https://fclm-portal.amazon.com/
// @version      1.5
// @description  Analyze indirect spending across support buckets by shift
// @author       Orcha + Natalia
// @match        https://fclm-portal.amazon.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      fclm-portal.amazon.com
// @connect      galaxybi.aka.corp.amazon.com
// @connect      galaxybiprintfile-prod.s3.us-west-2.amazonaws.com
// @connect      midway-auth.amazon.com
// @require      https://cdnjs.cloudflare.com/ajax/libs/PapaParse/5.3.2/papaparse.min.js
// @updateURL    https://raw.githubusercontent.com/ortmnata/indirect-spending-analysis/main/IndirectSpendingAnalysis.user.js
// @downloadURL  https://raw.githubusercontent.com/ortmnata/indirect-spending-analysis/main/IndirectSpendingAnalysis.user.js
// ==/UserScript==

(function () {
    'use strict';

    // ============================================================
    //                    CONFIGURATION
    // ============================================================
    
    const CONFIG = {
        PICK_SUPPORT_PROCESS_ID: '1003049',
        PACK_SUPPORT_PROCESS_ID: '1002994',
        SORT_SUPPORT_PROCESS_ID: '1003050',
        STOW_SUPPORT_PROCESS_ID: '1003017',
        TRANSFER_IN_SUPPORT_PROCESS_ID: '1003020',
        RSR_SUPPORT_PROCESS_ID: '1003012',
        SHIP_DOCK_SUPPORT_PROCESS_ID: '1720696536911',
        VRETURN_SUPPORT_PROCESS_ID: '1003059',
        ADMIN_HR_PROCESS_ID: '1002960',
        OPS_REGIONAL_FUNCTION_NAME: 'OPS_REGIONALPROJECTS',
        SETTINGS_KEY: 'SupportAnalysis_Settings_v1'
    };

    // CSV column indices (from Function Rollup CSV)
    // Verified against LAVA Dashboard v9 / Track4 parsers
    const CSV_COLS = {
        PROCESS_NAME: 0,
        FUNCTION_NAME: 1,
        EMPLOYEE_ID: 3,
        EMPLOYEE_NAME: 4,
        MANAGER_NAME: 5,
        PAID_HOURS: 10,   // "Paid Hours" is column 10, not 8
        TOTAL_MARKER: 15  // Column 15 = "Total" on summary rows
    };

    // ============================================================
    //                    UTILITY FUNCTIONS
    // ============================================================

    /**
     * Scans the header row for the correct paid hours column.
     * Strategy (in priority order):
     *   1. Exact match: "Paid Hours" (case-insensitive)
     *   2. Partial match containing "paid hours" (e.g. "Paid Hours-Total") — rightmost wins
     *   3. Fallback: column header matching "Total" (case-insensitive, rightmost non-empty)
     * If multiple matches exist for a strategy, returns the rightmost (Total) column index.
     * @param {string[]} headerRow - Array of column header strings from PapaParse
     * @returns {number} Column index, or -1 if not found
     */
    function findPaidHoursColumnIndex(headerRow) {
        if (!Array.isArray(headerRow)) return -1;

        let exactMatch = -1;
        let partialMatch = -1;
        let totalFallback = -1;

        for (let i = 0; i < headerRow.length; i++) {
            const cell = headerRow[i];
            if (typeof cell !== 'string') continue;
            const trimmed = cell.trim().toLowerCase();
            if (trimmed === '') continue; // skip empty

            if (trimmed === 'paid hours') {
                exactMatch = i; // keep scanning for rightmost
            }
            if (trimmed.includes('paid hours')) {
                partialMatch = i; // rightmost partial match (e.g. "Paid Hours-Total")
            }
            if (trimmed === 'total') {
                totalFallback = i; // rightmost "Total" column
            }
        }

        // Priority: exact > partial > "Total" fallback
        if (exactMatch !== -1) return exactMatch;
        if (partialMatch !== -1) return partialMatch;
        if (totalFallback !== -1) return totalFallback;
        return -1;
    }

    function pad2(n) {
        return String(n).padStart(2, '0');
    }

    function toYMD(d) {
        return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    }

    function formatDateForUrl(d) {
        return `${d.getFullYear()}%2F${pad2(d.getMonth() + 1)}%2F${pad2(d.getDate())}`;
    }

    function detectWarehouseId() {
        const href = window.location.href;
        const m = href.match(/[?&]warehouseId=([A-Z0-9]+)/i);
        if (m) return m[1].toUpperCase();
        
        // Try to find in page content
        if (document.body) {
            const txt = document.body.innerText || '';
            const match = txt.match(/Warehouse:\s*([A-Z0-9]{3,6})/i);
            if (match) return match[1].toUpperCase();
        }
        
        // Check fcmenu cookie
        const cookieMatch = document.cookie.match(/fcmenu-warehouseId=([A-Z0-9]+)/i);
        if (cookieMatch) return cookieMatch[1].toUpperCase();
        
        return 'HOU6'; // Default for your site
    }

    function gmFetch(url, timeoutMs = 60000) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                responseType: 'text',
                headers: {
                    'Accept': 'text/csv,application/csv,*/*',
                    'User-Agent': navigator.userAgent
                },
                withCredentials: true,
                timeout: timeoutMs,
                onload: r => {
                    if (r.status >= 200 && r.status < 300) {
                        const text = r.responseText || '';
                        if (text.trim().startsWith('<') && text.toLowerCase().includes('<html')) {
                            reject(new Error('Session expired or authentication required. Please refresh the page.'));
                        } else {
                            resolve(text);
                        }
                    } else {
                        reject(new Error(`HTTP error ${r.status}`));
                    }
                },
                onerror: e => reject(new Error(`Network error: ${e.error || 'connection failed'}`)),
                ontimeout: () => reject(new Error(`Request timed out after ${timeoutMs / 1000}s`))
            });
        });
    }

    // Determine shift based on date and time
    function determineShift(dateTime) {
        if (!(dateTime instanceof Date) || isNaN(dateTime)) return 'Unknown';
        
        const hour = dateTime.getHours();
        const dayOfWeek = dateTime.getDay(); // 0 = Sunday, 6 = Saturday
        
        // Days: 6 AM - 6 PM, Nights: 6 PM - 6 AM
        const isDays = hour >= 6 && hour < 18;
        
        // FHD/FHN: Sun (0), Mon (1), Tue (2)
        // OD/ON: Wed (3) — Overlap day
        // BHD/BHN: Thu (4), Fri (5), Sat (6)
        if (dayOfWeek >= 0 && dayOfWeek <= 2) {
            return isDays ? 'FHD' : 'FHN';
        } else if (dayOfWeek === 3) {
            return isDays ? 'OD' : 'ON';
        } else {
            return isDays ? 'BHD' : 'BHN';
        }
    }

    // For overnight shifts, determine shift from the shift START time
    function determineShiftFromRange(startDate, endDate) {
        // Use the start time to determine the shift
        return determineShift(startDate);
    }

    /**
     * Computes the most recent Sunday (at 00:00:00 local time) from any given date.
     * @param {Date} date - Any date
     * @returns {string} YYYY-MM-DD formatted string of the most recent Sunday
     */
    function computeReportWeekSunday(date) {
        const d = new Date(date);
        d.setHours(0, 0, 0, 0);
        const dayOfWeek = d.getDay(); // 0 = Sunday
        d.setDate(d.getDate() - dayOfWeek);
        return toYMD(d);
    }

    async function loadSettings() {
        const defaults = {
            spanType: 'Intraday',
            shiftDate: toYMD(new Date()),
            shiftStart: '06:00',
            shiftEnd: '18:00',
            weekDate: toYMD(new Date()),
            monthValue: `${new Date().getFullYear()}-${pad2(new Date().getMonth() + 1)}`
        };
        
        try {
            const stored = await GM_getValue(CONFIG.SETTINGS_KEY, null);
            if (stored && typeof stored === 'object') {
                return { ...defaults, ...stored };
            }
        } catch (e) {}
        
        return defaults;
    }

    async function saveSettings(settings) {
        try {
            await GM_setValue(CONFIG.SETTINGS_KEY, settings);
        } catch (e) {
            console.warn('Failed to save settings:', e);
        }
    }

    /**
     * Checks if the cached LP data is still valid.
     * @param {object|null} cache - Cached object: { warehouseId, week, timestamp, expiryMs, data }
     * @param {string} currentWarehouse - Current warehouse ID
     * @param {string} currentWeek - Current report week Sunday (YYYY-MM-DD)
     * @param {number} now - Current timestamp (Date.now())
     * @returns {boolean} true if cache is valid
     */
    function isLPCacheValid(cache, currentWarehouse, currentWeek, now) {
        if (!cache || typeof cache !== 'object') return false;
        if (cache.warehouseId !== currentWarehouse) return false;
        if (cache.week !== currentWeek) return false;
        const expiryMs = cache.expiryMs || (3 * 60 * 60 * 1000); // default 3 hours
        if ((now - cache.timestamp) >= expiryMs) return false;
        return true;
    }

    /**
     * Returns styling info for a percent-to-plan value.
     * @param {number|null} pctValue - Percent to plan value, or null if unavailable
     * @returns {{text: string, bgColor: string, textColor: string}}
     */
    function getRateColorStyle(pctValue) {
        if (pctValue == null) {
            return { text: '—', bgColor: '', textColor: '' };
        }
        const text = pctValue.toFixed(2) + '%';
        if (pctValue > 100) {
            return { text, bgColor: '#dcfce7', textColor: '#16a34a' };
        } else if (pctValue < 100) {
            return { text, bgColor: '#fef2f2', textColor: '#dc2626' };
        } else {
            // Exactly 100 — no color styling
            return { text, bgColor: '', textColor: '' };
        }
    }

    // ============================================================
    //                    TOAST NOTIFICATIONS
    // ============================================================

    function showToast(message, options = {}) {
        // Remove existing toast if any
        const existing = document.getElementById('sa-toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.id = 'sa-toast';
        toast.className = 'sa-toast';
        toast.innerHTML = `
            <span>⚠️ ${message}${options.link ? ` <a href="${options.link}" target="_blank">${options.linkText || 'Click here'}</a>` : ''}</span>
            <button class="sa-toast-close">×</button>
        `;
        document.body.appendChild(toast);

        toast.querySelector('.sa-toast-close').addEventListener('click', () => toast.remove());

        // Auto-dismiss after duration (default 10s)
        const duration = options.duration || 10000;
        setTimeout(() => { if (toast.parentNode) toast.remove(); }, duration);
    }

    // ============================================================
    //                    API / DATA FETCHING
    // ============================================================

    function buildFunctionRollupUrl(warehouseId, processId, params) {
        const { spanType, startDT, endDT, weekStart, monthStart } = params;
        
        let url = `https://fclm-portal.amazon.com/reports/functionRollup?reportFormat=CSV` +
            `&warehouseId=${encodeURIComponent(warehouseId)}` +
            `&processId=${encodeURIComponent(processId)}` +
            `&spanType=${spanType}`;
        
        if (spanType === 'Intraday') {
            // Detect overnight shift: endDT is on a later calendar day than startDT
            const isOvernight = (endDT.getFullYear() !== startDT.getFullYear()) ||
                (endDT.getMonth() !== startDT.getMonth()) ||
                (endDT.getDate() !== startDT.getDate());
            const maxIntradayDays = isOvernight ? 2 : 1;

            url += `&startDateDay=${formatDateForUrl(startDT)}` +
                `&maxIntradayDays=${maxIntradayDays}` +
                `&startDateIntraday=${formatDateForUrl(startDT)}` +
                `&startHourIntraday=${startDT.getHours()}` +
                `&startMinuteIntraday=${startDT.getMinutes()}` +
                `&endDateIntraday=${formatDateForUrl(endDT)}` +
                `&endHourIntraday=${endDT.getHours()}` +
                `&endMinuteIntraday=${endDT.getMinutes()}`;
        } else if (spanType === 'Day') {
            url += `&maxIntradayDays=1&startDateDay=${formatDateForUrl(startDT)}`;
        } else if (spanType === 'Week') {
            url += `&maxIntradayDays=1&startDateWeek=${formatDateForUrl(weekStart)}`;
        } else if (spanType === 'Month') {
            url += `&maxIntradayDays=1&startDateMonth=${formatDateForUrl(monthStart)}`;
        }
        
        return url;
    }

    async function fetchFunctionRollupCSV(warehouseId, processId, params) {
        const url = buildFunctionRollupUrl(warehouseId, processId, params);
        console.log('Fetching:', url);
        const csv = await gmFetch(url, 90000);
        return csv;
    }

    function parseCSV(csvText) {
        const parsed = Papa.parse(csvText.trim(), { skipEmptyLines: true });
        return parsed.data || [];
    }

    /**
     * Builds the Process Path Rollup URL using the same time range params
     * as Function Rollup but targeting the processPathRollup endpoint.
     * @param {string} warehouseId
     * @param {object} params - Same query params object used for Function Rollup
     * @returns {string} The PPR URL
     */
    function buildPPRUrl(warehouseId, params) {
        const { spanType, startDT, endDT, weekStart, monthStart } = params;

        let url = `https://fclm-portal.amazon.com/reports/processPathRollup?reportFormat=CSV` +
            `&warehouseId=${encodeURIComponent(warehouseId)}` +
            `&spanType=${spanType}`;

        if (spanType === 'Intraday') {
            const isOvernight = (endDT.getFullYear() !== startDT.getFullYear()) ||
                (endDT.getMonth() !== startDT.getMonth()) ||
                (endDT.getDate() !== startDT.getDate());
            const maxIntradayDays = isOvernight ? 2 : 1;

            url += `&startDateDay=${formatDateForUrl(startDT)}` +
                `&maxIntradayDays=${maxIntradayDays}` +
                `&startDateIntraday=${formatDateForUrl(startDT)}` +
                `&startHourIntraday=${startDT.getHours()}` +
                `&startMinuteIntraday=${startDT.getMinutes()}` +
                `&endDateIntraday=${formatDateForUrl(endDT)}` +
                `&endHourIntraday=${endDT.getHours()}` +
                `&endMinuteIntraday=${endDT.getMinutes()}`;
        } else if (spanType === 'Day') {
            url += `&maxIntradayDays=1&startDateDay=${formatDateForUrl(startDT)}`;
        } else if (spanType === 'Week') {
            url += `&maxIntradayDays=1&startDateWeek=${formatDateForUrl(weekStart)}`;
        } else if (spanType === 'Month') {
            url += `&maxIntradayDays=1&startDateMonth=${formatDateForUrl(monthStart)}`;
        }

        return url;
    }

    /**
     * Fetches Process Path Rollup CSV from FCLM and extracts
     * volume, actual rate, and plan rate per process path.
     * @param {string} warehouseId
     * @param {object} params - Same query params used for Function Rollup
     * @returns {Promise<Map<string, {volume: number, actualRate: number, planRate: number}>|null>}
     */
    async function fetchPPRData(warehouseId, params) {
        try {
            const url = buildPPRUrl(warehouseId, params);
            console.log('[SupportAnalysis] Fetching PPR:', url);
            const csvText = await gmFetch(url, 90000);
            const parsed = Papa.parse(csvText.trim(), { skipEmptyLines: true });
            const rows = parsed.data || [];

            if (rows.length < 2) return null;

            // DEBUG: Log first few rows to understand CSV structure
            console.log('[SupportAnalysis] PPR CSV first row (header):', rows[0]);
            if (rows.length > 1) console.log('[SupportAnalysis] PPR CSV second row:', rows[1]);

            // Find the header row — the PPR CSV from FCLM has these known columns:
            // "Report", "Line Number", "LineItem Id", "LineItem Name", "Main Process", 
            // "Core Process", "Unit Type", "Actual Volume", "Actual Hours", "Actual Rate", ...
            let headerRowIndex = -1;
            let colProcessPath = -1;
            let colActualVolume = -1;
            let colActualRate = -1;
            let colPlanRate = -1;

            // Scan up to first 5 rows for the header
            for (let i = 0; i < Math.min(rows.length, 5); i++) {
                const row = rows[i];
                
                for (let j = 0; j < row.length; j++) {
                    const cell = (row[j] || '').trim().toLowerCase();
                    if (!cell) continue;
                    
                    // LineItem Name / Process Path Name column
                    if (cell === 'lineitem name' || cell === 'line item name' || 
                        cell.includes('lineitem name') || cell.includes('line item') ||
                        cell.includes('lineitem') || cell.includes('process path') || 
                        (cell === 'name' && j > 2)) {
                        colProcessPath = j;
                        headerRowIndex = i;
                    }
                    // Actual Volume
                    if (cell === 'actual volume' || (cell.includes('actual') && cell.includes('vol') && !cell.includes('rate'))) {
                        colActualVolume = j;
                    }
                    // Actual Rate / Actual Productivity (but NOT "actual volume")
                    if (cell === 'actual rate' || cell === 'actual productivity' ||
                        (cell.includes('actual') && (cell.includes('rate') || cell.includes('productivity') || cell.includes('uph')) && !cell.includes('vol'))) {
                        colActualRate = j;
                    }
                    // Plan Rate / Plan Productivity / Target Rate
                    // Must NOT match "Hours @ Plan Rate" or "% to Plan" or "Plan Variance"
                    if ((cell === 'plan rate' || cell === 'plan productivity' || 
                        cell === 'planned rate' || cell === 'target rate' ||
                        cell === 'planproductivity') &&
                        !cell.includes('hours') && !cell.includes('%') && !cell.includes('variance')) {
                        colPlanRate = j;
                    } else if (colPlanRate === -1 && 
                        cell.includes('plan') && (cell.includes('productivity') || cell.includes('rate')) &&
                        !cell.includes('hours') && !cell.includes('%') && !cell.includes('variance') && !cell.includes('@')) {
                        colPlanRate = j;
                    }
                }
                if (headerRowIndex !== -1) break;
            }

            // If we still couldn't find the header row, return null
            if (headerRowIndex === -1 || colProcessPath === -1) {
                console.warn('[SupportAnalysis] PPR: Could not identify header row. First row:', rows[0]);
                return null;
            }

            console.log(`[SupportAnalysis] PPR header found at row ${headerRowIndex}. Columns: name=${colProcessPath}, vol=${colActualVolume}, actRate=${colActualRate}, planRate=${colPlanRate}`);

            // Build the result map from data rows
            const result = new Map();
            for (let i = headerRowIndex + 1; i < rows.length; i++) {
                const row = rows[i];
                const processName = (row[colProcessPath] || '').trim();
                if (!processName) continue;
                
                // Skip summary/total rows — only use DETAIL_PPR rows if "Report" column exists
                const reportCol = (row[0] || '').trim().toUpperCase();
                if (reportCol && reportCol !== 'DETAIL_PPR' && reportCol.includes('SUMMARY')) continue;

                const volume = colActualVolume !== -1 ? parseFloat(row[colActualVolume]) : NaN;
                const actualRate = colActualRate !== -1 ? parseFloat(row[colActualRate]) : NaN;
                const planRate = colPlanRate !== -1 ? parseFloat(row[colPlanRate]) : NaN;

                result.set(processName, {
                    volume: isNaN(volume) ? 0 : volume,
                    actualRate: isNaN(actualRate) ? 0 : actualRate,
                    planRate: isNaN(planRate) ? 0 : planRate
                });
            }

            console.log(`[SupportAnalysis] PPR result: ${result.size} line items:`, [...result.keys()]);
            return result;
        } catch (e) {
            console.error('[SupportAnalysis] PPR fetch failed:', e);
            return null;
        }
    }

    /**
     * Fetches LP rate data from GalaxyBI DeratedRates.
     * Uses GM_xmlhttpRequest with cookies for Midway auth.
     * Caches results in GM_setValue with 3-hour TTL.
     *
     * @param {string} warehouseId - e.g. "HOU6"
     * @param {Date} reportDate - Analysis date (used to compute report week Sunday)
     * @returns {Promise<Map<string, number>|null>} Map of processPathName → LP rate, or null on failure
     */
    async function fetchLPData(warehouseId, reportDate) {
        const LP_CACHE_KEY = 'SA_LP_Cache';
        const LP_API_URL = 'https://galaxybi.aka.corp.amazon.com/api/metadata/pageUrl';
        const LP_REPORT_NAME = 'DeratedRates';
        const LP_TYPE = 'Forecast'; // Default LP type
        const LP_EXPIRY_MS = 3 * 60 * 60 * 1000; // 3 hours

        try {
            // Compute report week Sunday
            const reportWeek = computeReportWeekSunday(reportDate);

            // Check cache
            const cached = await GM_getValue(LP_CACHE_KEY, null);
            if (cached && isLPCacheValid(cached, warehouseId, reportWeek, Date.now())) {
                console.log('[SupportAnalysis] Using cached LP data');
                return new Map(Object.entries(cached.data));
            }

            // Request metadata URL
            const metadataUrl = `${LP_API_URL}?pageName=${LP_REPORT_NAME}&site=${warehouseId}&reportDate=${reportWeek}`;
            console.log('[SupportAnalysis] Fetching LP metadata:', metadataUrl);

            const metaResponse = await new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: metadataUrl,
                    withCredentials: true,
                    timeout: 30000,
                    onload: r => {
                        // Detect auth redirect
                        if (r.finalUrl && r.finalUrl !== metadataUrl && r.finalUrl.includes('midway')) {
                            reject(new Error('AUTH_REDIRECT'));
                        } else if (r.status === 401 || r.status === 403) {
                            reject(new Error('AUTH_FAILED'));
                        } else if (r.status >= 200 && r.status < 300) {
                            resolve(r.responseText);
                        } else {
                            reject(new Error(`HTTP ${r.status}`));
                        }
                    },
                    onerror: e => reject(new Error('NETWORK_ERROR')),
                    ontimeout: () => reject(new Error('TIMEOUT'))
                });
            });

            // Parse metadata response to get report URL
            const metaJson = JSON.parse(metaResponse);
            const reportUrl = metaJson.url;
            if (!reportUrl) {
                console.warn('[SupportAnalysis] LP metadata returned no URL');
                return null;
            }

            // Fetch the actual report JSON from S3
            console.log('[SupportAnalysis] Fetching LP report:', reportUrl);
            const reportResponse = await new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: reportUrl,
                    withCredentials: true,
                    timeout: 30000,
                    onload: r => {
                        if (r.status >= 200 && r.status < 300) {
                            resolve(r.responseText);
                        } else {
                            reject(new Error(`HTTP ${r.status}`));
                        }
                    },
                    onerror: e => reject(new Error('NETWORK_ERROR')),
                    ontimeout: () => reject(new Error('TIMEOUT'))
                });
            });

            // Parse and filter LP data
            const reportData = JSON.parse(reportResponse);
            const lpMap = new Map();

            reportData.forEach(item => {
                if (item.type === LP_TYPE && item.date === reportWeek && item.value > 0) {
                    lpMap.set(item.lineItem, item.value);
                }
            });

            // Cache the result
            const cacheObj = {
                warehouseId,
                week: reportWeek,
                timestamp: Date.now(),
                expiryMs: LP_EXPIRY_MS,
                data: Object.fromEntries(lpMap)
            };
            await GM_setValue(LP_CACHE_KEY, cacheObj);
            console.log(`[SupportAnalysis] LP data cached: ${lpMap.size} line items`);

            return lpMap;
        } catch (e) {
            if (e.message === 'AUTH_REDIRECT' || e.message === 'AUTH_FAILED') {
                console.warn('[SupportAnalysis] GalaxyBI authentication required');
                showToast('LP rates unavailable — please authenticate to GalaxyBI first.', {
                    link: 'https://galaxybi.aka.corp.amazon.com',
                    linkText: 'Open GalaxyBI',
                    duration: 15000
                });
            } else {
                console.error('[SupportAnalysis] LP fetch failed:', e);
            }
            return null;
        }
    }

    function processPickSupportData(csvRows, shiftLabel, typeLabel = 'Pick Support') {
        // Validate header row exists
        if (!csvRows || csvRows.length === 0 || !csvRows[0]) {
            console.error(`[SupportAnalysis] ${typeLabel}: No header row found in CSV data`);
            return [];
        }

        // DEBUG: Log header row so we can see actual CSV column structure
        console.log(`[SupportAnalysis] ${typeLabel} CSV Headers:`, csvRows[0]);
        console.log(`[SupportAnalysis] ${typeLabel} Total rows (incl header):`, csvRows.length);

        // Use header-based column detection for paid hours
        const paidHoursIdx = findPaidHoursColumnIndex(csvRows[0]);
        if (paidHoursIdx === -1) {
            console.error(`[SupportAnalysis] ${typeLabel}: Paid Hours column not found in CSV header`);
            return [];
        }

        // DEBUG: Log which column was selected
        console.log(`[SupportAnalysis] ${typeLabel} using column ${paidHoursIdx} ("${csvRows[0][paidHoursIdx]}") for paid hours`);

        const dataRows = csvRows.slice(1);
        const results = [];
        
        // Support process CSVs have variable columns:
        // [0] Process Name (Main Process Path from FCLM)
        // [1] Function Name, [2] Employee Type, [3] Employee Id,
        // [4] Name, [5] Manager, [6+] Paid Hours columns...
        const PS_COLS = {
            PROCESS_NAME: 0,
            FUNCTION_NAME: 1,
            EMPLOYEE_ID: 3,
            EMPLOYEE_NAME: 4,
            MANAGER_NAME: 5
        };

        // Detect if CSV has "Total" summary rows (Week/Month queries do, Intraday typically don't)
        // If Total rows exist, ONLY use those to avoid double-counting daily breakdowns
        const hasTotalRows = dataRows.some(row => row.length > 15 && (row[15] || '').trim() === 'Total');
        
        dataRows.forEach(row => {
            if (row.length < 7) return;

            // If the CSV has Total summary rows, skip non-Total rows to avoid double-counting
            if (hasTotalRows && row.length > 15) {
                const marker = (row[15] || '').trim();
                if (marker !== 'Total') return;
            }
            
            // Validate paid hours value from the detected column
            const paidHoursRaw = (row[paidHoursIdx] || '').toString().trim();
            if (paidHoursRaw === '') return; // Skip empty/whitespace
            const paidHours = parseFloat(paidHoursRaw);
            if (isNaN(paidHours)) return; // Skip non-numeric
            if (paidHours < 0) return; // Skip negative

            // Use Process Name from CSV (column 0) as the type — this is the FCLM Main Process Path
            const processName = (row[PS_COLS.PROCESS_NAME] || '').trim();
            const functionName = (row[PS_COLS.FUNCTION_NAME] || '').trim();
            const employeeId = (row[PS_COLS.EMPLOYEE_ID] || '').trim();
            const employeeName = (row[PS_COLS.EMPLOYEE_NAME] || '').trim();
            const managerName = (row[PS_COLS.MANAGER_NAME] || '').trim();
            
            if (!employeeId || employeeId === '0' || !functionName) return;
            
            results.push({
                type: processName || typeLabel,
                functionName,
                employeeId,
                employeeName,
                managerName,
                paidHours,
                shift: shiftLabel
            });
        });
        
        return results;
    }

    function processOpsRegionalData(csvRows, shiftLabel) {
        // Skip header row
        const dataRows = csvRows.length > 1 ? csvRows.slice(1) : [];
        const results = [];
        
        dataRows.forEach(row => {
            // FCLM CSV has 18+ columns; only process "Total" summary rows
            if (row.length < 18) return;
            if ((row[CSV_COLS.TOTAL_MARKER] || '').trim() !== 'Total') return;
            
            const functionName = (row[CSV_COLS.FUNCTION_NAME] || '').trim();
            const employeeId = (row[CSV_COLS.EMPLOYEE_ID] || '').trim();
            const employeeName = (row[CSV_COLS.EMPLOYEE_NAME] || '').trim();
            const managerName = (row[CSV_COLS.MANAGER_NAME] || '').trim();
            const paidHours = parseFloat(row[CSV_COLS.PAID_HOURS] || '0') || 0;
            
            // Only include OPS_REGIONALPROJECTS
            if (functionName !== CONFIG.OPS_REGIONAL_FUNCTION_NAME) return;
            if (!employeeId || employeeId === '0') return;
            
            results.push({
                type: 'Ops Regional',
                functionName,
                employeeId,
                employeeName,
                managerName,
                paidHours,
                shift: shiftLabel
            });
        });
        
        return results;
    }

    /**
     * Processes Admin HR IT data from the same processId (1002960) CSV.
     * Captures ALL sub-functions EXCEPT OPS_REGIONALPROJECTS (which is handled separately).
     * Each row gets typed as "Admin HR IT" with the sub-function preserved in functionName.
     */
    function processAdminHRData(csvRows, shiftLabel) {
        // Skip header row
        const dataRows = csvRows.length > 1 ? csvRows.slice(1) : [];
        const results = [];
        
        dataRows.forEach(row => {
            // FCLM CSV has 18+ columns; only process "Total" summary rows
            if (row.length < 18) return;
            if ((row[CSV_COLS.TOTAL_MARKER] || '').trim() !== 'Total') return;
            
            const functionName = (row[CSV_COLS.FUNCTION_NAME] || '').trim();
            const employeeId = (row[CSV_COLS.EMPLOYEE_ID] || '').trim();
            const employeeName = (row[CSV_COLS.EMPLOYEE_NAME] || '').trim();
            const managerName = (row[CSV_COLS.MANAGER_NAME] || '').trim();
            const paidHours = parseFloat(row[CSV_COLS.PAID_HOURS] || '0') || 0;
            
            // Exclude OPS_REGIONALPROJECTS — that's handled as its own bucket
            if (functionName === CONFIG.OPS_REGIONAL_FUNCTION_NAME) return;
            if (!functionName) return;
            if (!employeeId || employeeId === '0') return;
            
            results.push({
                type: 'Admin HR IT',
                functionName,
                employeeId,
                employeeName,
                managerName,
                paidHours,
                shift: shiftLabel
            });
        });
        
        return results;
    }

    // ============================================================
    //                    ANALYSIS LOGIC
    // ============================================================

    /**
     * Pure function: computes rate metrics for a single support process.
     * @param {string} processName - Process path name (e.g. "Pick Support")
     * @param {number|null} hours - Total paid hours from Function Rollup
     * @param {Map<string, {volume: number, actualRate: number, planRate: number}>|null} pprData - PPR data map
     * @param {Map<string, number>|null} lpData - LP rate map (lineItem → rate value)
     * @returns {{actualVolume: number|null, actualRate: number|null, lpRate: number|null, opRate: number|null, pctToLP: number|null, pctToOP: number|null}}
     */
    function computeRateMetrics(processName, hours, pprData, lpData) {
        const result = {
            actualVolume: null,
            actualRate: null,
            lpRate: null,
            opRate: null,
            pctToLP: null,
            pctToOP: null
        };

        // Name mapping for PPR/LP lookups — try exact name first, then variants
        const nameVariants = [processName];
        if (processName === 'V-Returns Support') nameVariants.push('V-Return Support');
        if (processName === 'Ship Dock Support') nameVariants.push('Ship Dock');
        if (processName === 'Stow Support') nameVariants.push('Stow to Prime Support');
        if (processName === 'Sort Support') nameVariants.push('Sort Support');

        // Look up PPR data for this support process (volume + OP plan rate)
        let ppr = null;
        if (pprData) {
            for (const name of nameVariants) {
                ppr = pprData.get(name);
                if (ppr) break;
            }
        }

        // Look up LP rate from GalaxyBI
        let lp = null;
        if (lpData) {
            for (const name of nameVariants) {
                lp = lpData.get(name);
                if (lp && lp > 0) break;
            }
        }
        if (lp && lp > 0) {
            result.lpRate = lp;
        }

        // Volume comes from PPR (core path volume that this support team is supporting)
        if (ppr) {
            result.actualVolume = (ppr.volume != null && ppr.volume >= 0) ? ppr.volume : null;
            result.opRate = (ppr.planRate != null && ppr.planRate > 0) ? ppr.planRate : null;
        }

        // Rate = PPR Volume ÷ Our Function Rollup Hours
        // (This gives the true staffing efficiency using OUR hours, not PPR's hours)
        if (result.actualVolume != null && result.actualVolume > 0 && hours != null && hours > 0) {
            result.actualRate = Math.round((result.actualVolume / hours) * 100) / 100;
        }

        // % to LP = Our Rate ÷ LP Rate × 100
        if (result.actualRate != null && result.lpRate != null && result.lpRate > 0) {
            result.pctToLP = Math.round((result.actualRate / result.lpRate) * 100 * 100) / 100;
        }

        // % to OP = Our Rate ÷ OP Plan Rate × 100
        if (result.actualRate != null && result.opRate != null && result.opRate > 0) {
            result.pctToOP = Math.round((result.actualRate / result.opRate) * 100 * 100) / 100;
        }

        return result;
    }

    async function runAnalysis(settings, updateStatus) {
        const warehouseId = detectWarehouseId();
        updateStatus(`Analyzing support hours for ${warehouseId}...`);
        
        // Build query parameters based on span type
        const params = buildQueryParams(settings);
        
        // Launch LP and PPR fetches in parallel (don't await here — let them run alongside Function Rollup fetches)
        const lpPromise = fetchLPData(warehouseId, params.startDT).catch(e => {
            console.warn('[SupportAnalysis] LP fetch failed:', e);
            return null;
        });
        const pprPromise = fetchPPRData(warehouseId, params).catch(e => {
            console.warn('[SupportAnalysis] PPR fetch failed:', e);
            return null;
        });
        
        const allData = [];
        
        // Fetch Pick Support data
        updateStatus('Fetching Pick Support data...');
        try {
            const pickCsv = await fetchFunctionRollupCSV(warehouseId, CONFIG.PICK_SUPPORT_PROCESS_ID, params);
            const pickRows = parseCSV(pickCsv);
            const pickData = processPickSupportData(pickRows, params.shiftLabel, 'Pick Support');
            allData.push(...pickData);
            updateStatus(`Found ${pickData.length} Pick Support records`);
        } catch (e) {
            console.error('Pick Support fetch failed:', e);
            updateStatus(`Pick Support error: ${e.message}`);
        }
        
        // Fetch Pack Support data
        updateStatus('Fetching Pack Support data...');
        try {
            const packCsv = await fetchFunctionRollupCSV(warehouseId, CONFIG.PACK_SUPPORT_PROCESS_ID, params);
            const packRows = parseCSV(packCsv);
            const packData = processPickSupportData(packRows, params.shiftLabel, 'Pack Support');
            allData.push(...packData);
            updateStatus(`Found ${packData.length} Pack Support records`);
        } catch (e) {
            console.error('Pack Support fetch failed:', e);
            updateStatus(`Pack Support error: ${e.message}`);
        }
        
        // Fetch Sort Support data
        updateStatus('Fetching Sort Support data...');
        try {
            const sortCsv = await fetchFunctionRollupCSV(warehouseId, CONFIG.SORT_SUPPORT_PROCESS_ID, params);
            const sortRows = parseCSV(sortCsv);
            const sortData = processPickSupportData(sortRows, params.shiftLabel, 'Sort Support');
            allData.push(...sortData);
            updateStatus(`Found ${sortData.length} Sort Support records`);
        } catch (e) {
            console.error('Sort Support fetch failed:', e);
            updateStatus(`Sort Support error: ${e.message}`);
        }
        
        // Fetch Stow Support data
        updateStatus('Fetching Stow Support data...');
        try {
            const stowCsv = await fetchFunctionRollupCSV(warehouseId, CONFIG.STOW_SUPPORT_PROCESS_ID, params);
            const stowRows = parseCSV(stowCsv);
            const stowData = processPickSupportData(stowRows, params.shiftLabel, 'Stow Support');
            allData.push(...stowData);
            updateStatus(`Found ${stowData.length} Stow Support records`);
        } catch (e) {
            console.error('Stow Support fetch failed:', e);
            updateStatus(`Stow Support error: ${e.message}`);
        }
        
        // Fetch Transfer In Support data
        updateStatus('Fetching Transfer In Support data...');
        try {
            const tiCsv = await fetchFunctionRollupCSV(warehouseId, CONFIG.TRANSFER_IN_SUPPORT_PROCESS_ID, params);
            const tiRows = parseCSV(tiCsv);
            const tiData = processPickSupportData(tiRows, params.shiftLabel, 'Transfer In Support');
            allData.push(...tiData);
            updateStatus(`Found ${tiData.length} Transfer In Support records`);
        } catch (e) {
            console.error('Transfer In Support fetch failed:', e);
            updateStatus(`Transfer In Support error: ${e.message}`);
        }
        
        // Fetch RSR Support data
        updateStatus('Fetching RSR Support data...');
        try {
            const rsrCsv = await fetchFunctionRollupCSV(warehouseId, CONFIG.RSR_SUPPORT_PROCESS_ID, params);
            const rsrRows = parseCSV(rsrCsv);
            const rsrData = processPickSupportData(rsrRows, params.shiftLabel, 'RSR Support');
            allData.push(...rsrData);
            updateStatus(`Found ${rsrData.length} RSR Support records`);
        } catch (e) {
            console.error('RSR Support fetch failed:', e);
            updateStatus(`RSR Support error: ${e.message}`);
        }
        
        // Fetch Ship Dock Support data
        updateStatus('Fetching Ship Dock Support data...');
        try {
            const sdCsv = await fetchFunctionRollupCSV(warehouseId, CONFIG.SHIP_DOCK_SUPPORT_PROCESS_ID, params);
            const sdRows = parseCSV(sdCsv);
            const sdData = processPickSupportData(sdRows, params.shiftLabel, 'Ship Dock Support');
            allData.push(...sdData);
            updateStatus(`Found ${sdData.length} Ship Dock Support records`);
        } catch (e) {
            console.error('Ship Dock Support fetch failed:', e);
            updateStatus(`Ship Dock Support error: ${e.message}`);
        }
        
        // Fetch V-Returns Support data
        updateStatus('Fetching V-Returns Support data...');
        try {
            const vrCsv = await fetchFunctionRollupCSV(warehouseId, CONFIG.VRETURN_SUPPORT_PROCESS_ID, params);
            const vrRows = parseCSV(vrCsv);
            const vrData = processPickSupportData(vrRows, params.shiftLabel, 'V-Returns Support');
            allData.push(...vrData);
            updateStatus(`Found ${vrData.length} V-Returns Support records`);
        } catch (e) {
            console.error('V-Returns Support fetch failed:', e);
            updateStatus(`V-Returns Support error: ${e.message}`);
        }
        
        // Fetch Ops Regional data
        updateStatus('Fetching Ops Regional data...');
        try {
            const opsCsv = await fetchFunctionRollupCSV(warehouseId, CONFIG.ADMIN_HR_PROCESS_ID, params);
            const opsRows = parseCSV(opsCsv);
            const opsData = processOpsRegionalData(opsRows, params.shiftLabel);
            allData.push(...opsData);
            updateStatus(`Found ${opsData.length} Ops Regional records`);
            
            // Also extract Admin HR IT sub-functions from the same CSV
            const adminHRData = processAdminHRData(opsRows, params.shiftLabel);
            allData.push(...adminHRData);
            updateStatus(`Found ${adminHRData.length} Admin HR IT records`);
        } catch (e) {
            console.error('Ops Regional / Admin HR IT fetch failed:', e);
            updateStatus(`Ops Regional error: ${e.message}`);
        }
        
        // Await LP and PPR data (these were launched in parallel with Function Rollup fetches)
        updateStatus('Fetching rate data...');
        const [lpData, pprData] = await Promise.all([lpPromise, pprPromise]);
        
        // DEBUG: Log PPR and LP results
        console.log('[SupportAnalysis] LP data:', lpData ? `${lpData.size} items: ${[...lpData.keys()].join(', ')}` : 'null/failed');
        console.log('[SupportAnalysis] PPR data:', pprData ? `${pprData.size} items: ${[...pprData.keys()].join(', ')}` : 'null/failed');
        
        if (!allData.length) {
            throw new Error('No data found for the selected timeframe.');
        }
        
        // Apply process filter
        const processFilter = document.getElementById('sa-process-filter').value;
        const filteredData = processFilter === 'all' 
            ? allData 
            : allData.filter(row => row.type === processFilter);
        
        if (!filteredData.length) {
            throw new Error(`No data found for "${processFilter}" in the selected timeframe.`);
        }
        
        // Aggregate data
        updateStatus('Aggregating results...');
        const summary = aggregateData(filteredData);
        
        // Compute rate metrics for each process type
        const rateMetrics = {};
        Object.entries(summary.byType).forEach(([typeName, val]) => {
            rateMetrics[typeName] = computeRateMetrics(typeName, val.hours, pprData, lpData);
        });
        // DEBUG: Log rate metrics results
        console.log('[SupportAnalysis] Rate metrics by type:', JSON.stringify(rateMetrics, null, 2));
        
        // Build shift comparison if viewing a full day or longer
        let shiftComparison = null;
        if (params.spanType === 'Day' || params.spanType === 'Week' || params.spanType === 'Month') {
            updateStatus('Building shift comparison...');
            shiftComparison = buildShiftComparison(filteredData, params);
        }
        
        return {
            warehouseId,
            settings,
            params,
            rawData: allData,
            summary,
            shiftComparison,
            rateMetrics,
            _lpData: lpData,    // Internal — for shift comparison computation
            _pprData: pprData   // Internal — for shift comparison computation
        };
    }

    // Build shift comparison by querying each shift window separately
    function buildShiftComparison(data, params) {
        // For Day view, we can estimate shifts from the single query
        // The data doesn't have per-shift granularity from a single Day/Week/Month pull,
        // so we'll track it as a combined view and add a "Run Shift Comparison" button
        // that does 4 separate intraday queries
        return null; // Placeholder — real comparison handled by runShiftComparison
    }
    
    async function runShiftComparison(settings, updateStatus) {
        const warehouseId = detectWarehouseId();
        updateStatus('Running shift comparison...');
        
        const baseDate = settings.shiftDate || toYMD(new Date());
        const spanType = settings.spanType || 'Intraday';
        
        const processIds = [
            { id: CONFIG.PICK_SUPPORT_PROCESS_ID, label: 'Pick Support' },
            { id: CONFIG.PACK_SUPPORT_PROCESS_ID, label: 'Pack Support' },
            { id: CONFIG.SORT_SUPPORT_PROCESS_ID, label: 'Sort Support' },
            { id: CONFIG.STOW_SUPPORT_PROCESS_ID, label: 'Stow Support' },
            { id: CONFIG.TRANSFER_IN_SUPPORT_PROCESS_ID, label: 'Transfer In Support' },
            { id: CONFIG.RSR_SUPPORT_PROCESS_ID, label: 'RSR Support' },
            { id: CONFIG.SHIP_DOCK_SUPPORT_PROCESS_ID, label: 'Ship Dock Support' },
            { id: CONFIG.VRETURN_SUPPORT_PROCESS_ID, label: 'V-Returns Support' },
            { id: CONFIG.ADMIN_HR_PROCESS_ID, label: 'Ops Regional' }
        ];
        
        // Build list of shift windows to query based on span type
        // For Week/Month: query all shifts in the period
        // For Day: query both shifts on that day
        // For Intraday: query both shifts on that day
        let shiftWindows = [];
        
        if (spanType === 'Week') {
            // Get the week start date
            const weekStart = new Date(`${settings.weekDate || baseDate}T00:00:00`);
            // Query 7 days × 2 shifts each, grouped by shift label
            for (let d = 0; d < 7; d++) {
                const date = new Date(weekStart);
                date.setDate(date.getDate() + d);
                const dow = date.getDay();
                const dateStr = toYMD(date);
                
                let dayLabel, nightLabel;
                if (dow >= 0 && dow <= 2) { dayLabel = 'FHD'; nightLabel = 'FHN'; }
                else if (dow === 3) { dayLabel = 'OD'; nightLabel = 'ON'; }
                else { dayLabel = 'BHD'; nightLabel = 'BHN'; }
                
                shiftWindows.push({ label: dayLabel, date: dateStr, startH: 6, endH: 18, overnight: false });
                shiftWindows.push({ label: nightLabel, date: dateStr, startH: 18, endH: 6, overnight: true });
            }
        } else if (spanType === 'Month') {
            // Get all days in the month
            const [year, month] = (settings.monthValue || `${new Date().getFullYear()}-${pad2(new Date().getMonth() + 1)}`).split('-').map(Number);
            const daysInMonth = new Date(year, month, 0).getDate();
            for (let d = 1; d <= daysInMonth; d++) {
                const date = new Date(year, month - 1, d);
                const dow = date.getDay();
                const dateStr = toYMD(date);
                
                let dayLabel, nightLabel;
                if (dow >= 0 && dow <= 2) { dayLabel = 'FHD'; nightLabel = 'FHN'; }
                else if (dow === 3) { dayLabel = 'OD'; nightLabel = 'ON'; }
                else { dayLabel = 'BHD'; nightLabel = 'BHN'; }
                
                shiftWindows.push({ label: dayLabel, date: dateStr, startH: 6, endH: 18, overnight: false });
                shiftWindows.push({ label: nightLabel, date: dateStr, startH: 18, endH: 6, overnight: true });
            }
        } else {
            // Intraday or Day — just the selected day
            const dateObj = new Date(`${baseDate}T12:00:00`);
            const dow = dateObj.getDay();
            let dayLabel, nightLabel;
            if (dow >= 0 && dow <= 2) { dayLabel = 'FHD'; nightLabel = 'FHN'; }
            else if (dow === 3) { dayLabel = 'OD'; nightLabel = 'ON'; }
            else { dayLabel = 'BHD'; nightLabel = 'BHN'; }
            
            shiftWindows.push({ label: dayLabel, date: baseDate, startH: 6, endH: 18, overnight: false });
            shiftWindows.push({ label: nightLabel, date: baseDate, startH: 18, endH: 6, overnight: true });
        }
        
        // Group shift windows by label and aggregate
        const shiftGroups = {}; // label → [windows]
        shiftWindows.forEach(sw => {
            if (!shiftGroups[sw.label]) shiftGroups[sw.label] = [];
            shiftGroups[sw.label].push(sw);
        });
        
        // Fetch data for each shift group
        const shiftResults = [];
        const orderedLabels = ['FHD', 'FHN', 'OD', 'ON', 'BHD', 'BHN'];
        
        for (const label of orderedLabels) {
            if (!shiftGroups[label]) continue;
            const windows = shiftGroups[label];
            updateStatus(`Fetching ${label} data (${windows.length} windows)...`);
            
            const shiftData = [];
            for (const win of windows) {
                const startDT = new Date(`${win.date}T${pad2(win.startH)}:00:00`);
                const endDT = new Date(`${win.date}T${pad2(win.endH)}:00:00`);
                if (win.overnight) endDT.setDate(endDT.getDate() + 1);
                
                const params = {
                    spanType: 'Intraday',
                    startDT,
                    endDT,
                    weekStart: startDT,
                    monthStart: new Date(startDT.getFullYear(), startDT.getMonth(), 1),
                    shiftLabel: label
                };
                
                for (const proc of processIds) {
                    try {
                        const csv = await fetchFunctionRollupCSV(warehouseId, proc.id, params);
                        const rows = parseCSV(csv);
                        if (proc.label === 'Ops Regional') {
                            shiftData.push(...processOpsRegionalData(rows, label));
                            shiftData.push(...processAdminHRData(rows, label));
                        } else {
                            shiftData.push(...processPickSupportData(rows, label, proc.label));
                        }
                    } catch (e) { /* skip failures */ }
                }
            }
            
            // Apply process filter
            const processFilter = document.getElementById('sa-process-filter').value;
            const filtered = processFilter === 'all' ? shiftData : shiftData.filter(r => r.type === processFilter);
            
            shiftResults.push({
                label,
                data: filtered,
                summary: aggregateData(filtered)
            });
        }
        
        return {
            warehouseId,
            baseDate,
            shifts: shiftResults
        };
    }

    function buildQueryParams(settings) {
        const spanType = settings.spanType || 'Intraday';
        let startDT, endDT, weekStart, monthStart, shiftLabel;
        
        if (spanType === 'Intraday') {
            const [startH, startM] = (settings.shiftStart || '06:00').split(':').map(Number);
            const [endH, endM] = (settings.shiftEnd || '18:00').split(':').map(Number);
            
            startDT = new Date(`${settings.shiftDate}T${pad2(startH)}:${pad2(startM)}:00`);
            endDT = new Date(`${settings.shiftDate}T${pad2(endH)}:${pad2(endM)}:00`);
            
            // Handle overnight shifts
            if (endDT <= startDT) {
                endDT.setDate(endDT.getDate() + 1);
            }
            
            shiftLabel = determineShiftFromRange(startDT, endDT);
            weekStart = startDT;
            monthStart = new Date(startDT.getFullYear(), startDT.getMonth(), 1);
            
        } else if (spanType === 'Day') {
            startDT = new Date(`${settings.shiftDate}T00:00:00`);
            endDT = new Date(`${settings.shiftDate}T23:59:59`);
            shiftLabel = 'Full Day';
            weekStart = startDT;
            monthStart = new Date(startDT.getFullYear(), startDT.getMonth(), 1);
            
        } else if (spanType === 'Week') {
            weekStart = new Date(`${settings.weekDate}T00:00:00`);
            startDT = weekStart;
            endDT = new Date(weekStart);
            endDT.setDate(endDT.getDate() + 6);
            shiftLabel = 'Full Week';
            monthStart = new Date(startDT.getFullYear(), startDT.getMonth(), 1);
            
        } else if (spanType === 'Month') {
            const [year, month] = settings.monthValue.split('-').map(Number);
            monthStart = new Date(year, month - 1, 1);
            startDT = monthStart;
            endDT = new Date(year, month, 0); // Last day of month
            shiftLabel = 'Full Month';
            weekStart = monthStart;
        }
        
        return { spanType, startDT, endDT, weekStart, monthStart, shiftLabel };
    }

    function aggregateData(data) {
        // Summary by Type (Pick Support vs Ops Regional)
        const byType = {};
        
        // Summary by Function (for Pick Support sub-functions)
        const byFunction = {};
        
        // Summary by Manager
        const byManager = {};
        
        // Unique employees: key includes shift to allow same employee across shifts
        // but deduplicates within a shift to prevent double-counting from overlapping queries
        const uniqueEmployees = new Map();
        
        data.forEach(row => {
            // Key includes shift label so an employee counted in FHD isn't blocked from BHD
            // But within the same shift, same employee-function combo is only counted once
            const key = `${row.employeeId}-${row.functionName}-${row.shift}`;
            
            if (!uniqueEmployees.has(key)) {
                uniqueEmployees.set(key, row);
            } else {
                // If same key appears again (e.g., from multiple day windows within the same shift),
                // accumulate the hours instead of dropping
                const existing = uniqueEmployees.get(key);
                existing.paidHours += row.paidHours;
                return; // Skip re-adding to aggregates — we'll rebuild from uniqueEmployees below
            }
        });
        
        // Now aggregate from the deduplicated + accumulated map
        uniqueEmployees.forEach((row) => {
            // By Type
            if (!byType[row.type]) {
                byType[row.type] = { hours: 0, employees: new Set() };
            }
            byType[row.type].hours += row.paidHours;
            byType[row.type].employees.add(row.employeeId);
            
            // By Function
            const funcKey = `${row.type} - ${row.functionName}`;
            if (!byFunction[funcKey]) {
                byFunction[funcKey] = { hours: 0, employees: new Set(), type: row.type };
            }
            byFunction[funcKey].hours += row.paidHours;
            byFunction[funcKey].employees.add(row.employeeId);
            
            // By Manager
            if (!byManager[row.managerName]) {
                byManager[row.managerName] = { 
                    total: 0,
                    employees: new Set(),
                    byType: {}
                };
            }
            if (!byManager[row.managerName].byType[row.type]) {
                byManager[row.managerName].byType[row.type] = 0;
            }
            byManager[row.managerName].byType[row.type] += row.paidHours;
            byManager[row.managerName].total += row.paidHours;
            byManager[row.managerName].employees.add(row.employeeId);
        });
        
        return { byType, byFunction, byManager };
    }

    // ============================================================
    //                    UI COMPONENTS
    // ============================================================

    function injectStyles() {
        const style = document.createElement('style');
        style.textContent = `
            /* Floating Button */
            #support-analysis-btn {
                position: fixed;
                top: 120px;
                right: 24px;
                z-index: 9999;
                width: 56px;
                height: 56px;
                border-radius: 50%;
                background: linear-gradient(135deg, #10b981 0%, #059669 50%, #047857 100%);
                border: 2px solid rgba(255,255,255,0.3);
                cursor: grab;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 24px;
                box-shadow: 0 8px 24px rgba(16, 185, 129, 0.4), 0 4px 8px rgba(0,0,0,0.1);
                transition: transform 0.2s ease, box-shadow 0.2s ease;
            }
            #support-analysis-btn:active {
                cursor: grabbing;
            }
            #support-analysis-btn:hover {
                transform: scale(1.1);
                box-shadow: 0 12px 32px rgba(16, 185, 129, 0.5), 0 6px 12px rgba(0,0,0,0.15);
            }
            #support-analysis-btn::after {
                content: '📊';
                font-size: 28px;
            }
            
            /* Main Panel */
            #support-analysis-panel {
                position: fixed;
                top: 120px;
                right: 90px;
                width: 420px;
                max-height: calc(100vh - 140px);
                background: linear-gradient(180deg, #ffffff 0%, #f8fafc 100%);
                border-radius: 16px;
                box-shadow: 0 25px 60px rgba(0,0,0,0.15), 0 10px 20px rgba(0,0,0,0.1);
                padding: 0;
                z-index: 9998;
                font-family: "Amazon Ember", -apple-system, BlinkMacSystemFont, sans-serif;
                font-size: 13px;
                display: none;
                overflow: hidden;
                border: 1px solid rgba(0,0,0,0.08);
            }
            
            /* Panel Header */
            .sa-header {
                background: linear-gradient(135deg, #10b981 0%, #059669 100%);
                color: white;
                padding: 16px 20px;
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            .sa-header-title {
                font-size: 18px;
                font-weight: 700;
                display: flex;
                align-items: center;
                gap: 8px;
            }
            .sa-header-title::before {
                content: '📊';
                font-size: 20px;
            }
            .sa-header-close {
                background: rgba(255,255,255,0.2);
                border: none;
                color: white;
                width: 32px;
                height: 32px;
                border-radius: 50%;
                cursor: pointer;
                font-size: 18px;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: background 0.2s;
            }
            .sa-header-close:hover {
                background: rgba(255,255,255,0.3);
            }
            
            /* Panel Body */
            .sa-body {
                padding: 20px;
                overflow-y: auto;
                max-height: calc(100vh - 280px);
            }
            
            /* Warehouse Badge */
            .sa-warehouse {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                background: linear-gradient(135deg, #dbeafe 0%, #bfdbfe 100%);
                color: #1e40af;
                padding: 8px 14px;
                border-radius: 20px;
                font-weight: 700;
                font-size: 12px;
                margin-bottom: 16px;
                border: 1px solid #93c5fd;
            }
            .sa-warehouse::before {
                content: '🏭';
            }
            
            /* Input Groups */
            .sa-input-group {
                margin-bottom: 14px;
            }
            .sa-label {
                display: block;
                font-weight: 600;
                color: #374151;
                margin-bottom: 6px;
                font-size: 12px;
            }
            .sa-input, .sa-select {
                width: 100%;
                padding: 10px 12px;
                border: 1px solid #d1d5db;
                border-radius: 8px;
                font-size: 13px;
                background: white;
                transition: border-color 0.2s, box-shadow 0.2s;
                box-sizing: border-box;
            }
            .sa-input:focus, .sa-select:focus {
                outline: none;
                border-color: #10b981;
                box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.15);
            }
            
            /* Time Row */
            .sa-time-row {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 12px;
            }
            
            /* Buttons */
            .sa-btn {
                padding: 12px 20px;
                border-radius: 8px;
                font-weight: 700;
                font-size: 13px;
                cursor: pointer;
                transition: transform 0.1s, box-shadow 0.1s;
                border: none;
            }
            .sa-btn:hover {
                transform: translateY(-1px);
            }
            .sa-btn-primary {
                background: linear-gradient(135deg, #10b981 0%, #059669 100%);
                color: white;
                box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);
                width: 100%;
            }
            .sa-btn-primary:hover {
                box-shadow: 0 6px 16px rgba(16, 185, 129, 0.4);
            }
            .sa-btn-primary:disabled {
                opacity: 0.6;
                cursor: not-allowed;
                transform: none;
            }
            
            /* Loading Overlay */
            .sa-loading {
                position: absolute;
                inset: 0;
                background: rgba(255,255,255,0.95);
                display: none;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                z-index: 10;
                border-radius: 16px;
            }
            .sa-loading.active {
                display: flex;
            }
            .sa-spinner {
                width: 48px;
                height: 48px;
                border: 4px solid #e5e7eb;
                border-top-color: #10b981;
                border-radius: 50%;
                animation: sa-spin 0.8s linear infinite;
                margin-bottom: 16px;
            }
            @keyframes sa-spin {
                to { transform: rotate(360deg); }
            }
            .sa-loading-text {
                color: #374151;
                font-weight: 600;
                text-align: center;
            }
            
            /* Results Modal */
            #support-analysis-results {
                position: fixed;
                inset: 0;
                background: rgba(0,0,0,0.5);
                backdrop-filter: blur(4px);
                display: none;
                align-items: center;
                justify-content: center;
                z-index: 10001;
            }
            #support-analysis-results.active {
                display: flex;
            }
            .sa-results-inner {
                background: white;
                border-radius: 16px;
                width: fit-content;
                min-width: 600px;
                max-width: 95vw;
                max-height: 85vh;
                display: flex;
                flex-direction: column;
                box-shadow: 0 25px 60px rgba(0,0,0,0.3);
            }
            .sa-results-header {
                background: linear-gradient(135deg, #10b981 0%, #059669 100%);
                color: white;
                padding: 16px 24px;
                display: flex;
                justify-content: space-between;
                align-items: center;
                border-radius: 16px 16px 0 0;
            }
            .sa-results-title {
                font-size: 18px;
                font-weight: 700;
            }
            .sa-results-subtitle {
                font-size: 12px;
                opacity: 0.9;
                margin-top: 4px;
            }
            .sa-results-actions {
                display: flex;
                gap: 8px;
            }
            .sa-results-btn {
                background: rgba(255,255,255,0.2);
                border: 1px solid rgba(255,255,255,0.3);
                color: white;
                padding: 8px 16px;
                border-radius: 6px;
                cursor: pointer;
                font-weight: 600;
                font-size: 12px;
                transition: background 0.2s;
            }
            .sa-results-btn:hover {
                background: rgba(255,255,255,0.3);
            }
            .sa-results-body {
                padding: 24px;
                overflow-y: auto;
                flex: 1;
            }
            
            /* Summary Cards */
            .sa-summary-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
                gap: 8px;
                margin-bottom: 16px;
            }
            .sa-summary-card {
                background: linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%);
                border: 1px solid #86efac;
                border-radius: 8px;
                padding: 10px 8px;
                text-align: center;
            }
            /* Color 0 - Green (default) */
            .sa-summary-card.color-0 {
                background: linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%);
                border-color: #86efac;
            }
            .sa-summary-card.color-0 .sa-summary-value { color: #059669; }
            /* Color 1 - Blue */
            .sa-summary-card.color-1 {
                background: linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%);
                border-color: #93c5fd;
            }
            .sa-summary-card.color-1 .sa-summary-value { color: #1d4ed8; }
            /* Color 2 - Orange */
            .sa-summary-card.color-2 {
                background: linear-gradient(135deg, #fff7ed 0%, #ffedd5 100%);
                border-color: #fdba74;
            }
            .sa-summary-card.color-2 .sa-summary-value { color: #c2410c; }
            /* Color 3 - Teal */
            .sa-summary-card.color-3 {
                background: linear-gradient(135deg, #f0fdfa 0%, #ccfbf1 100%);
                border-color: #5eead4;
            }
            .sa-summary-card.color-3 .sa-summary-value { color: #0f766e; }
            /* Color 4 - Rose/Pink */
            .sa-summary-card.color-4 {
                background: linear-gradient(135deg, #fff1f2 0%, #ffe4e6 100%);
                border-color: #fda4af;
            }
            .sa-summary-card.color-4 .sa-summary-value { color: #be123c; }
            /* Color 5 - Indigo */
            .sa-summary-card.color-5 {
                background: linear-gradient(135deg, #eef2ff 0%, #e0e7ff 100%);
                border-color: #a5b4fc;
            }
            .sa-summary-card.color-5 .sa-summary-value { color: #4338ca; }
            /* Color 6 - Amber */
            .sa-summary-card.color-6 {
                background: linear-gradient(135deg, #fffbeb 0%, #fef3c7 100%);
                border-color: #fcd34d;
            }
            .sa-summary-card.color-6 .sa-summary-value { color: #b45309; }
            /* Color 7 - Cyan */
            .sa-summary-card.color-7 {
                background: linear-gradient(135deg, #ecfeff 0%, #cffafe 100%);
                border-color: #67e8f9;
            }
            .sa-summary-card.color-7 .sa-summary-value { color: #0e7490; }
            /* Total card - Purple */
            .sa-summary-card.total {
                background: linear-gradient(135deg, #faf5ff 0%, #f3e8ff 100%);
                border-color: #c4b5fd;
            }
            .sa-summary-value {
                font-size: 20px;
                font-weight: 800;
                color: #059669;
            }
            .sa-summary-card.total .sa-summary-value {
                color: #7c3aed;
            }
            .sa-summary-label {
                font-size: 12px;
                color: #6b7280;
                margin-top: 4px;
                font-weight: 600;
            }
            
            /* Section Title */
            .sa-section-title {
                font-size: 16px;
                font-weight: 700;
                color: #111827;
                margin: 24px 0 12px 0;
                padding-bottom: 8px;
                border-bottom: 2px solid #e5e7eb;
            }

            /* Toast Notification */
            .sa-toast {
                position: fixed;
                bottom: 24px;
                right: 24px;
                background: #1f2937;
                color: white;
                padding: 12px 20px;
                border-radius: 10px;
                font-size: 13px;
                font-family: "Amazon Ember", -apple-system, sans-serif;
                box-shadow: 0 8px 24px rgba(0,0,0,0.25);
                z-index: 10010;
                display: flex;
                align-items: center;
                gap: 10px;
                animation: sa-toast-in 0.3s ease;
                max-width: 420px;
            }
            .sa-toast a {
                color: #67e8f9;
                text-decoration: underline;
                font-weight: 600;
            }
            .sa-toast-close {
                background: none;
                border: none;
                color: #9ca3af;
                font-size: 18px;
                cursor: pointer;
                padding: 0 4px;
                margin-left: 8px;
            }
            .sa-toast-close:hover { color: white; }
            @keyframes sa-toast-in {
                from { opacity: 0; transform: translateY(12px); }
                to { opacity: 1; transform: translateY(0); }
            }
            
            /* Tables */
            .sa-table {
                width: 100%;
                border-collapse: collapse;
                font-size: 12px;
            }
            .sa-table th, .sa-table td {
                padding: 10px 12px;
                text-align: left;
                border-bottom: 1px solid #e5e7eb;
            }
            .sa-table th {
                background: #f9fafb;
                font-weight: 700;
                color: #374151;
                position: sticky;
                top: 0;
            }
            .sa-table tr:hover {
                background: #f9fafb;
            }
            .sa-table td:last-child, .sa-table th:last-child {
                text-align: right;
            }
            
            /* Error Message */
            .sa-error {
                background: #fef2f2;
                border: 1px solid #fecaca;
                color: #dc2626;
                padding: 12px 16px;
                border-radius: 8px;
                margin-bottom: 16px;
                display: none;
            }
            .sa-error.show {
                display: block;
            }
        `;
        document.head.appendChild(style);
    }

    function createUI() {
        // Floating button
        const btn = document.createElement('button');
        btn.id = 'support-analysis-btn';
        btn.title = 'Indirect Spending Analysis';
        document.body.appendChild(btn);
        
        // Main panel
        const panel = document.createElement('div');
        panel.id = 'support-analysis-panel';
        panel.innerHTML = `
            <div class="sa-header">
                <div class="sa-header-title">Indirect Spending Analysis</div>
                <button class="sa-header-close">×</button>
            </div>
            <div class="sa-body">
                <div class="sa-warehouse">Warehouse: ${detectWarehouseId()}</div>
                
                <div class="sa-error" id="sa-error"></div>
                
                <div class="sa-input-group">
                    <label class="sa-label">Time Range</label>
                    <select class="sa-select" id="sa-span-type">
                        <option value="Intraday">Intraday (Custom Hours)</option>
                        <option value="Day">Full Day</option>
                        <option value="Week">Full Week</option>
                        <option value="Month">Full Month</option>
                    </select>
                </div>
                
                <div id="sa-intraday-inputs">
                    <div class="sa-input-group">
                        <label class="sa-label">Date</label>
                        <input type="date" class="sa-input" id="sa-date">
                    </div>
                    <div class="sa-time-row">
                        <div class="sa-input-group">
                            <label class="sa-label">Start Time</label>
                            <input type="time" class="sa-input" id="sa-start-time" value="06:00">
                        </div>
                        <div class="sa-input-group">
                            <label class="sa-label">End Time</label>
                            <input type="time" class="sa-input" id="sa-end-time" value="18:00">
                        </div>
                    </div>
                </div>
                
                <div id="sa-day-inputs" style="display:none;">
                    <div class="sa-input-group">
                        <label class="sa-label">Select Day</label>
                        <input type="date" class="sa-input" id="sa-day-date">
                    </div>
                </div>
                
                <div id="sa-week-inputs" style="display:none;">
                    <div class="sa-input-group">
                        <label class="sa-label">Week Start Date</label>
                        <input type="date" class="sa-input" id="sa-week-date">
                        <div style="font-size:11px; color:#6b7280; margin-top:4px;">
                            Select the first day of the week (Sunday recommended)
                        </div>
                    </div>
                </div>
                
                <div id="sa-month-inputs" style="display:none;">
                    <div class="sa-input-group">
                        <label class="sa-label">Select Month</label>
                        <input type="month" class="sa-input" id="sa-month">
                    </div>
                </div>
                
                <div class="sa-input-group">
                    <label class="sa-label">Filter by Process</label>
                    <select class="sa-select" id="sa-process-filter">
                        <option value="all">All Support Processes</option>
                        <option value="Pick Support">Pick Support</option>
                        <option value="Pack Support">Pack Support</option>
                        <option value="Sort Support">Sort Support</option>
                        <option value="Stow Support">Stow Support</option>
                        <option value="Transfer In Support">Transfer In Support</option>
                        <option value="RSR Support">RSR Support</option>
                        <option value="Ship Dock Support">Ship Dock Support</option>
                        <option value="V-Returns Support">V-Returns Support</option>
                        <option value="Ops Regional">Ops Regional</option>
                        <option value="Admin HR IT">Admin HR IT</option>
                    </select>
                </div>
                
                <button class="sa-btn sa-btn-primary" id="sa-run-btn">
                    🔍 Analyze Support Hours
                </button>
            </div>
            
            <div class="sa-loading" id="sa-loading">
                <div class="sa-spinner"></div>
                <div class="sa-loading-text" id="sa-loading-text">Loading...</div>
            </div>
        `;
        document.body.appendChild(panel);
        
        // Results modal
        const resultsModal = document.createElement('div');
        resultsModal.id = 'support-analysis-results';
        resultsModal.innerHTML = `
            <div class="sa-results-inner">
                <div class="sa-results-header">
                    <div>
                        <div class="sa-results-title">📊 Indirect Spending Analysis Results</div>
                        <div class="sa-results-subtitle" id="sa-results-subtitle"></div>
                    </div>
                    <div class="sa-results-actions">
                        <button class="sa-results-btn" id="sa-copy-btn">📋 Copy</button>
                        <button class="sa-results-btn" id="sa-close-results">✕ Close</button>
                    </div>
                </div>
                <div class="sa-results-body" id="sa-results-body"></div>
            </div>
        `;
        document.body.appendChild(resultsModal);
        
        // Wire up events
        attachEvents();
    }

    function attachEvents() {
        const btn = document.getElementById('support-analysis-btn');
        const panel = document.getElementById('support-analysis-panel');
        const closeBtn = panel.querySelector('.sa-header-close');
        const spanSelect = document.getElementById('sa-span-type');
        const runBtn = document.getElementById('sa-run-btn');
        const resultsModal = document.getElementById('support-analysis-results');
        const closeResults = document.getElementById('sa-close-results');
        const copyBtn = document.getElementById('sa-copy-btn');
        
        // ---- Draggable button ----
        let isDragging = false;
        let dragStartX, dragStartY, btnStartX, btnStartY;
        let hasMoved = false;
        
        btn.addEventListener('mousedown', (e) => {
            isDragging = true;
            hasMoved = false;
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            const rect = btn.getBoundingClientRect();
            btnStartX = rect.left;
            btnStartY = rect.top;
            btn.style.transition = 'none';
            e.preventDefault();
        });
        
        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const dx = e.clientX - dragStartX;
            const dy = e.clientY - dragStartY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasMoved = true;
            if (!hasMoved) return;
            
            let newX = btnStartX + dx;
            let newY = btnStartY + dy;
            
            // Constrain to viewport
            newX = Math.max(0, Math.min(window.innerWidth - 56, newX));
            newY = Math.max(0, Math.min(window.innerHeight - 56, newY));
            
            btn.style.left = newX + 'px';
            btn.style.top = newY + 'px';
            btn.style.right = 'auto';
        });
        
        document.addEventListener('mouseup', () => {
            if (!isDragging) return;
            isDragging = false;
            btn.style.transition = 'transform 0.2s ease, box-shadow 0.2s ease';
            
            // Save position
            if (hasMoved) {
                const pos = { left: btn.style.left, top: btn.style.top };
                GM_setValue('SupportAnalysis_BtnPos', JSON.stringify(pos));
            }
        });
        
        // Toggle panel (only if not dragged)
        btn.addEventListener('click', () => {
            if (hasMoved) return; // Don't toggle if we just dragged
            panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
        });
        
        closeBtn.addEventListener('click', () => {
            panel.style.display = 'none';
        });
        
        // Span type change
        spanSelect.addEventListener('change', updateInputVisibility);
        
        // Run analysis
        runBtn.addEventListener('click', handleRunAnalysis);
        
        // Close results
        closeResults.addEventListener('click', () => {
            resultsModal.classList.remove('active');
        });
        
        // Copy results
        copyBtn.addEventListener('click', copyResultsToClipboard);
        
        // Initialize
        initializeInputs();
    }

    async function initializeInputs() {
        const settings = await loadSettings();
        
        document.getElementById('sa-span-type').value = settings.spanType || 'Intraday';
        document.getElementById('sa-date').value = settings.shiftDate || toYMD(new Date());
        document.getElementById('sa-start-time').value = settings.shiftStart || '06:00';
        document.getElementById('sa-end-time').value = settings.shiftEnd || '18:00';
        document.getElementById('sa-day-date').value = settings.shiftDate || toYMD(new Date());
        document.getElementById('sa-week-date').value = settings.weekDate || toYMD(new Date());
        document.getElementById('sa-month').value = settings.monthValue || `${new Date().getFullYear()}-${pad2(new Date().getMonth() + 1)}`;
        
        updateInputVisibility();
        
        // Restore button position
        try {
            const posStr = await GM_getValue('SupportAnalysis_BtnPos', null);
            if (posStr) {
                const pos = JSON.parse(posStr);
                const btn = document.getElementById('support-analysis-btn');
                if (pos.left && pos.top) {
                    btn.style.left = pos.left;
                    btn.style.top = pos.top;
                    btn.style.right = 'auto';
                }
            }
        } catch (e) {}
    }

    function updateInputVisibility() {
        const spanType = document.getElementById('sa-span-type').value;
        
        document.getElementById('sa-intraday-inputs').style.display = spanType === 'Intraday' ? 'block' : 'none';
        document.getElementById('sa-day-inputs').style.display = spanType === 'Day' ? 'block' : 'none';
        document.getElementById('sa-week-inputs').style.display = spanType === 'Week' ? 'block' : 'none';
        document.getElementById('sa-month-inputs').style.display = spanType === 'Month' ? 'block' : 'none';
    }

    function getSettingsFromUI() {
        const spanType = document.getElementById('sa-span-type').value;
        
        return {
            spanType,
            shiftDate: spanType === 'Day' ? document.getElementById('sa-day-date').value : document.getElementById('sa-date').value,
            shiftStart: document.getElementById('sa-start-time').value,
            shiftEnd: document.getElementById('sa-end-time').value,
            weekDate: document.getElementById('sa-week-date').value,
            monthValue: document.getElementById('sa-month').value
        };
    }

    async function handleRunAnalysis() {
        const loading = document.getElementById('sa-loading');
        const loadingText = document.getElementById('sa-loading-text');
        const errorDiv = document.getElementById('sa-error');
        const runBtn = document.getElementById('sa-run-btn');
        
        errorDiv.classList.remove('show');
        loading.classList.add('active');
        runBtn.disabled = true;
        
        const settings = getSettingsFromUI();
        await saveSettings(settings);
        
        try {
            const results = await runAnalysis(settings, (msg) => {
                loadingText.textContent = msg;
            });
            
            // Also run shift comparison for the same date
            let shiftComp = null;
            try {
                shiftComp = await runShiftComparison(settings, (msg) => {
                    loadingText.textContent = msg;
                });
            } catch (e) {
                console.warn('Shift comparison failed:', e);
            }
            results.shiftComparison = shiftComp;
            
            // Attach rate metrics to shift comparison using LP/PPR data from main analysis
            if (shiftComp && shiftComp.shifts && (results._lpData || results._pprData)) {
                shiftComp.shifts.forEach(s => {
                    const rm = {};
                    Object.entries(s.summary.byType || {}).forEach(([typeName, val]) => {
                        rm[typeName] = computeRateMetrics(typeName, val.hours, results._pprData, results._lpData);
                    });
                    s.rateMetrics = rm;
                });
            }
            
            displayResults(results);
        } catch (e) {
            console.error('Analysis failed:', e);
            errorDiv.textContent = e.message || 'Analysis failed. Please try again.';
            errorDiv.classList.add('show');
        } finally {
            loading.classList.remove('active');
            runBtn.disabled = false;
        }
    }

    function displayResults(results) {
        const { warehouseId, params, summary } = results;
        const resultsModal = document.getElementById('support-analysis-results');
        const subtitle = document.getElementById('sa-results-subtitle');
        const body = document.getElementById('sa-results-body');
        
        // Build subtitle
        let rangeText = '';
        if (params.spanType === 'Intraday') {
            rangeText = `${toYMD(params.startDT)} ${pad2(params.startDT.getHours())}:${pad2(params.startDT.getMinutes())} - ${pad2(params.endDT.getHours())}:${pad2(params.endDT.getMinutes())}`;
        } else if (params.spanType === 'Day') {
            rangeText = toYMD(params.startDT);
        } else if (params.spanType === 'Week') {
            rangeText = `Week of ${toYMD(params.weekStart)}`;
        } else if (params.spanType === 'Month') {
            rangeText = `${params.monthStart.toLocaleString('default', { month: 'long', year: 'numeric' })}`;
        }
        subtitle.textContent = `${warehouseId} | ${params.spanType} | ${rangeText} | Shift: ${params.shiftLabel}`;
        
        // Calculate totals dynamically from whatever types are present
        const typeEntries = Object.entries(summary.byType).sort((a, b) => b[1].hours - a[1].hours);
        const totalHours = typeEntries.reduce((sum, [, val]) => sum + val.hours, 0);
        
        // Build results HTML - summary cards
        let html = `<div class="sa-summary-grid">`;
        typeEntries.forEach(([typeName, val], index) => {
            const colorClass = `color-${index % 8}`;
            html += `
                <div class="sa-summary-card ${colorClass}">
                    <div class="sa-summary-value">${val.hours.toFixed(2)}</div>
                    <div class="sa-summary-label">${typeName}</div>
                </div>
            `;
        });
        html += `
                <div class="sa-summary-card total">
                    <div class="sa-summary-value">${totalHours.toFixed(2)}</div>
                    <div class="sa-summary-label">Total Hours</div>
                </div>
            </div>
        `;
        
        // Shift comparison section — right after summary cards
        if (results.shiftComparison) {
            const sc = results.shiftComparison;
            const shiftLabels = sc.shifts.map(s => s.label);
            const allTypes = new Set();
            sc.shifts.forEach(s => {
                Object.keys(s.summary.byType || {}).forEach(t => allTypes.add(t));
            });
            
            html += `<div class="sa-section-title">⚖️ Shift Comparison — Hours by Process</div>`;
            html += `<table class="sa-table"><thead><tr><th>Process</th>`;
            shiftLabels.forEach(l => { html += `<th>${l}</th>`; });
            html += `</tr></thead><tbody>`;
            
            let totalByShift = shiftLabels.map(() => 0);
            
            [...allTypes].sort().forEach(typeName => {
                html += `<tr><td>${typeName}</td>`;
                shiftLabels.forEach((l, i) => {
                    const h = sc.shifts[i].summary.byType[typeName]?.hours || 0;
                    totalByShift[i] += h;
                    html += `<td>${h.toFixed(2)}</td>`;
                });
                html += `</tr>`;
            });
            
            // Total row
            html += `<tr style="font-weight:bold;border-top:2px solid #374151;"><td>TOTAL</td>`;
            totalByShift.forEach(t => { html += `<td>${t.toFixed(2)}</td>`; });
            html += `</tr></tbody></table>`;

            // After the hours shift comparison table, add rate comparison if data available
            if (sc.shifts.some(s => s.rateMetrics)) {
                html += `<div class="sa-section-title">📈 Shift Comparison — Rate to Plan</div>`;
                html += `<table class="sa-table"><thead><tr><th>Process</th>`;
                shiftLabels.forEach(l => { 
                    html += `<th>${l} Rate</th><th>${l} %LP</th><th>${l} %OP</th>`; 
                });
                html += `</tr></thead><tbody>`;
                
                [...allTypes].sort().forEach(typeName => {
                    html += `<tr><td>${typeName}</td>`;
                    shiftLabels.forEach((l, i) => {
                        const rm = sc.shifts[i].rateMetrics ? sc.shifts[i].rateMetrics[typeName] : null;
                        const actRate = rm && rm.actualRate != null ? rm.actualRate.toFixed(2) : '—';
                        const pctLP = getRateColorStyle(rm ? rm.pctToLP : null);
                        const pctOP = getRateColorStyle(rm ? rm.pctToOP : null);
                        html += `<td>${actRate}</td>`;
                        html += `<td style="background:${pctLP.bgColor};color:${pctLP.textColor}">${pctLP.text}</td>`;
                        html += `<td style="background:${pctOP.bgColor};color:${pctOP.textColor}">${pctOP.text}</td>`;
                    });
                    html += `</tr>`;
                });
                html += `</tbody></table>`;
            }
        }
        
        // Rate Metrics — by Process table
        if (results.rateMetrics) {
            console.log('[SupportAnalysis] Rendering rate metrics table. Keys:', Object.keys(results.rateMetrics));
            html += `<div class="sa-section-title">📈 Rate to Plan — by Process</div>`;
            html += `<table class="sa-table"><thead><tr>`;
            html += `<th>Process</th><th>Hours</th><th>HC</th><th>Act Vol</th><th>Act Rate</th><th>LP Rate</th><th>OP Rate</th><th>% LP</th><th>% OP</th>`;
            html += `</tr></thead><tbody>`;
            
            typeEntries.forEach(([typeName, val]) => {
                const rm = results.rateMetrics ? results.rateMetrics[typeName] : null;
                const actVol = rm && rm.actualVolume != null ? rm.actualVolume.toLocaleString() : '—';
                const actRate = rm && rm.actualRate != null ? rm.actualRate.toFixed(2) : '—';
                const lpRate = rm && rm.lpRate != null ? rm.lpRate.toFixed(2) : '—';
                const opRate = rm && rm.opRate != null ? rm.opRate.toFixed(2) : '—';
                const pctLP = getRateColorStyle(rm ? rm.pctToLP : null);
                const pctOP = getRateColorStyle(rm ? rm.pctToOP : null);
                
                html += `<tr>`;
                html += `<td>${typeName}</td>`;
                html += `<td>${val.hours.toFixed(2)}</td>`;
                html += `<td>${val.employees.size}</td>`;
                html += `<td>${actVol}</td>`;
                html += `<td>${actRate}</td>`;
                html += `<td>${lpRate}</td>`;
                html += `<td>${opRate}</td>`;
                html += `<td style="background:${pctLP.bgColor};color:${pctLP.textColor}">${pctLP.text}</td>`;
                html += `<td style="background:${pctOP.bgColor};color:${pctOP.textColor}">${pctOP.text}</td>`;
                html += `</tr>`;
            });
            
            html += `</tbody></table>`;
        }
        
        // Function breakdown (all support types)
        const functionEntries = Object.entries(summary.byFunction)
            .sort((a, b) => b[1].hours - a[1].hours);
        
        if (functionEntries.length > 0) {
            html += `
                <div class="sa-section-title">📦 Support by Function</div>
                <table class="sa-table">
                    <thead>
                        <tr>
                            <th>Type</th>
                            <th>Function</th>
                            <th>Employees</th>
                            <th>Hours</th>
                        </tr>
                    </thead>
                    <tbody>
            `;
            functionEntries.forEach(([key, val]) => {
                const funcName = key.replace(/^.+ - /, '');
                html += `
                    <tr>
                        <td>${val.type}</td>
                        <td>${funcName}</td>
                        <td>${val.employees.size}</td>
                        <td>${val.hours.toFixed(2)}</td>
                    </tr>
                `;
            });
            html += `</tbody></table>`;
        }
        
        // Manager breakdown
        const managerEntries = Object.entries(summary.byManager)
            .sort((a, b) => b[1].total - a[1].total);
        
        if (managerEntries.length > 0) {
            html += `
                <div class="sa-section-title">👥 Hours by Manager</div>
                <table class="sa-table">
                    <thead>
                        <tr>
                            <th>Manager</th>
                            ${typeEntries.map(([t]) => `<th>${t.replace(' Support', '').replace('Ops Regional', 'Ops Reg')}</th>`).join('')}
                            <th>Total</th>
                        </tr>
                    </thead>
                    <tbody>
            `;
            managerEntries.forEach(([name, val]) => {
                html += `
                    <tr>
                        <td>${name}</td>
                        ${typeEntries.map(([t]) => `<td>${(val.byType[t] || 0).toFixed(2)}</td>`).join('')}
                        <td>${val.total.toFixed(2)}</td>
                    </tr>
                `;
            });
            html += `</tbody></table>`;
        }
        
        // Shift identification section
        html += `
            <div class="sa-section-title">🕐 Shift Information</div>
            <div style="display:flex;gap:12px;align-items:center;padding:12px 16px;background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;">
                <div style="font-size:24px;font-weight:800;color:#0369a1;">${params.shiftLabel}</div>
                <div style="font-size:12px;color:#475569;">
                    ${toYMD(params.startDT)} ${pad2(params.startDT.getHours())}:${pad2(params.startDT.getMinutes())} — 
                    ${toYMD(params.endDT)} ${pad2(params.endDT.getHours())}:${pad2(params.endDT.getMinutes())}
                </div>
            </div>
        `;
        
        body.innerHTML = html;
        
        // Store results for copy
        window.__supportAnalysisResults = results;
        
        resultsModal.classList.add('active');
    }

    function copyResultsToClipboard() {
        const results = window.__supportAnalysisResults;
        if (!results) return;
        
        const { warehouseId, params, summary } = results;
        
        // Build range text
        let rangeText = '';
        if (params.spanType === 'Intraday') {
            rangeText = `${toYMD(params.startDT)} ${pad2(params.startDT.getHours())}:${pad2(params.startDT.getMinutes())} – ${pad2(params.endDT.getHours())}:${pad2(params.endDT.getMinutes())}`;
        } else if (params.spanType === 'Day') {
            rangeText = toYMD(params.startDT);
        } else if (params.spanType === 'Week') {
            rangeText = `Week of ${toYMD(params.weekStart)}`;
        } else if (params.spanType === 'Month') {
            rangeText = params.monthStart.toLocaleString('default', { month: 'long', year: 'numeric' });
        }
        
        const typeEntries = Object.entries(summary.byType).sort((a, b) => b[1].hours - a[1].hours);
        const totalHours = typeEntries.reduce((sum, [, val]) => sum + val.hours, 0);
        
        // Build HTML report for rich paste
        let html = `<div style="font-family:Arial,sans-serif;font-size:13px;">`;
        
        // Header
        html += `<div style="background:#059669;color:white;padding:10px 16px;border-radius:8px 8px 0 0;margin-bottom:12px;">`;
        html += `<b style="font-size:16px;">Indirect Spending Analysis | ${warehouseId}</b><br>`;
        html += `<span style="font-size:12px;opacity:0.9;">${params.spanType} | ${rangeText} | Shift: ${params.shiftLabel}</span>`;
        html += `</div>`;
        
        // Totals row
        html += `<table style="border-collapse:collapse;width:100%;margin-bottom:16px;"><tr>`;
        typeEntries.forEach(([typeName, val]) => {
            html += `<td style="text-align:center;padding:8px 6px;border:1px solid #d1d5db;border-radius:6px;">`;
            html += `<div style="font-size:18px;font-weight:800;color:#059669;">${val.hours.toFixed(2)}</div>`;
            html += `<div style="font-size:10px;color:#6b7280;">${typeName}</div>`;
            html += `</td>`;
        });
        html += `<td style="text-align:center;padding:8px 6px;border:1px solid #c4b5fd;border-radius:6px;background:#faf5ff;">`;
        html += `<div style="font-size:18px;font-weight:800;color:#7c3aed;">${totalHours.toFixed(2)}</div>`;
        html += `<div style="font-size:10px;color:#6b7280;">Total Hours</div>`;
        html += `</td></tr></table>`;
        
        // Shift Comparison table
        if (results.shiftComparison) {
            const sc = results.shiftComparison;
            const shiftLabels = sc.shifts.map(s => s.label);
            const allTypes = new Set();
            sc.shifts.forEach(s => {
                Object.keys(s.summary.byType || {}).forEach(t => allTypes.add(t));
            });
            
            html += `<div style="font-size:14px;font-weight:700;margin:12px 0 6px 0;">⚖️ Shift Comparison — Hours by Process</div>`;
            html += `<table style="border-collapse:collapse;width:100%;font-size:12px;margin-bottom:16px;">`;
            html += `<tr style="background:#f9fafb;">`;
            html += `<th style="text-align:left;padding:6px 8px;border-bottom:2px solid #d1d5db;">Process</th>`;
            shiftLabels.forEach(l => {
                html += `<th style="text-align:right;padding:6px 8px;border-bottom:2px solid #d1d5db;">${l}</th>`;
            });
            html += `</tr>`;
            
            let totalByShift = shiftLabels.map(() => 0);
            [...allTypes].sort().forEach(typeName => {
                html += `<tr>`;
                html += `<td style="padding:5px 8px;border-bottom:1px solid #e5e7eb;">${typeName}</td>`;
                shiftLabels.forEach((l, i) => {
                    const h = sc.shifts[i].summary.byType[typeName]?.hours || 0;
                    totalByShift[i] += h;
                    html += `<td style="text-align:right;padding:5px 8px;border-bottom:1px solid #e5e7eb;">${h.toFixed(2)}</td>`;
                });
                html += `</tr>`;
            });
            html += `<tr style="font-weight:bold;border-top:2px solid #374151;">`;
            html += `<td style="padding:6px 8px;">TOTAL</td>`;
            totalByShift.forEach(t => {
                html += `<td style="text-align:right;padding:6px 8px;">${t.toFixed(2)}</td>`;
            });
            html += `</tr></table>`;
        }
        
        // Rate metrics table
        if (results.rateMetrics) {
            html += `<div style="font-size:14px;font-weight:700;margin:12px 0 6px 0;">📈 Rate to Plan</div>`;
            html += `<table style="border-collapse:collapse;width:100%;font-size:12px;margin-bottom:16px;">`;
            html += `<tr style="background:#f9fafb;">`;
            html += `<th style="text-align:left;padding:6px 8px;border-bottom:2px solid #d1d5db;">Process</th>`;
            html += `<th style="text-align:right;padding:6px 8px;border-bottom:2px solid #d1d5db;">Act Vol</th>`;
            html += `<th style="text-align:right;padding:6px 8px;border-bottom:2px solid #d1d5db;">Act Rate</th>`;
            html += `<th style="text-align:right;padding:6px 8px;border-bottom:2px solid #d1d5db;">LP Rate</th>`;
            html += `<th style="text-align:right;padding:6px 8px;border-bottom:2px solid #d1d5db;">OP Rate</th>`;
            html += `<th style="text-align:right;padding:6px 8px;border-bottom:2px solid #d1d5db;">% LP</th>`;
            html += `<th style="text-align:right;padding:6px 8px;border-bottom:2px solid #d1d5db;">% OP</th>`;
            html += `</tr>`;
            
            typeEntries.forEach(([typeName]) => {
                const rm = results.rateMetrics[typeName];
                if (!rm) return;
                const actVol = rm.actualVolume != null ? rm.actualVolume.toLocaleString() : '—';
                const actRate = rm.actualRate != null ? rm.actualRate.toFixed(2) : '—';
                const lpRate = rm.lpRate != null ? rm.lpRate.toFixed(2) : '—';
                const opRate = rm.opRate != null ? rm.opRate.toFixed(2) : '—';
                const pctLP = rm.pctToLP != null ? rm.pctToLP.toFixed(2) + '%' : '—';
                const pctOP = rm.pctToOP != null ? rm.pctToOP.toFixed(2) + '%' : '—';
                
                html += `<tr>`;
                html += `<td style="padding:5px 8px;border-bottom:1px solid #e5e7eb;">${typeName}</td>`;
                html += `<td style="text-align:right;padding:5px 8px;border-bottom:1px solid #e5e7eb;">${actVol}</td>`;
                html += `<td style="text-align:right;padding:5px 8px;border-bottom:1px solid #e5e7eb;">${actRate}</td>`;
                html += `<td style="text-align:right;padding:5px 8px;border-bottom:1px solid #e5e7eb;">${lpRate}</td>`;
                html += `<td style="text-align:right;padding:5px 8px;border-bottom:1px solid #e5e7eb;">${opRate}</td>`;
                html += `<td style="text-align:right;padding:5px 8px;border-bottom:1px solid #e5e7eb;">${pctLP}</td>`;
                html += `<td style="text-align:right;padding:5px 8px;border-bottom:1px solid #e5e7eb;">${pctOP}</td>`;
                html += `</tr>`;
            });
            html += `</table>`;
        }
        
        // Top coded functions
        const functions = Object.entries(summary.byFunction)
            .sort((a, b) => b[1].hours - a[1].hours)
            .slice(0, 10);
        
        if (functions.length > 0) {
            html += `<div style="font-size:14px;font-weight:700;margin:12px 0 6px 0;">📦 Top Coded Functions</div>`;
            html += `<table style="border-collapse:collapse;width:100%;font-size:12px;margin-bottom:16px;">`;
            html += `<tr style="background:#f9fafb;">`;
            html += `<th style="text-align:left;padding:5px 8px;border-bottom:2px solid #d1d5db;">Function</th>`;
            html += `<th style="text-align:right;padding:5px 8px;border-bottom:2px solid #d1d5db;">Hours</th>`;
            html += `<th style="text-align:right;padding:5px 8px;border-bottom:2px solid #d1d5db;">HC</th>`;
            html += `</tr>`;
            functions.forEach(([key, val]) => {
                const name = key.replace(/^.+ - /, '');
                html += `<tr>`;
                html += `<td style="padding:4px 8px;border-bottom:1px solid #e5e7eb;">${name}</td>`;
                html += `<td style="text-align:right;padding:4px 8px;border-bottom:1px solid #e5e7eb;">${val.hours.toFixed(2)}</td>`;
                html += `<td style="text-align:right;padding:4px 8px;border-bottom:1px solid #e5e7eb;">${val.employees.size}</td>`;
                html += `</tr>`;
            });
            html += `</table>`;
        }
        
        // Top 5 managers
        const managers = Object.entries(summary.byManager)
            .sort((a, b) => b[1].total - a[1].total)
            .slice(0, 5);
        
        if (managers.length > 0) {
            html += `<div style="font-size:14px;font-weight:700;margin:12px 0 6px 0;">👥 Top 5 Managers</div>`;
            html += `<table style="border-collapse:collapse;width:100%;font-size:12px;">`;
            html += `<tr style="background:#f9fafb;">`;
            html += `<th style="text-align:left;padding:5px 8px;border-bottom:2px solid #d1d5db;">Manager</th>`;
            html += `<th style="text-align:right;padding:5px 8px;border-bottom:2px solid #d1d5db;">Total</th>`;
            html += `<th style="text-align:left;padding:5px 8px;border-bottom:2px solid #d1d5db;">Breakdown</th>`;
            html += `</tr>`;
            managers.forEach(([name, val]) => {
                const breakdown = Object.entries(val.byType)
                    .filter(([, h]) => h > 0)
                    .sort((a, b) => b[1] - a[1])
                    .map(([t, h]) => `${t}: ${h.toFixed(2)}`)
                    .join(' · ');
                html += `<tr>`;
                html += `<td style="padding:4px 8px;border-bottom:1px solid #e5e7eb;">${name}</td>`;
                html += `<td style="text-align:right;padding:4px 8px;border-bottom:1px solid #e5e7eb;font-weight:bold;">${val.total.toFixed(2)}</td>`;
                html += `<td style="padding:4px 8px;border-bottom:1px solid #e5e7eb;font-size:11px;color:#6b7280;">${breakdown}</td>`;
                html += `</tr>`;
            });
            html += `</table>`;
        }
        
        html += `</div>`;
        
        // Copy as rich HTML (for Slack/Chime/Email) with plain text fallback
        const plainText = buildPlainTextFallback(warehouseId, params, rangeText, typeEntries, totalHours, results, summary, functions, managers);
        
        // Use ClipboardItem API for rich HTML copy
        try {
            const blob = new Blob([html], { type: 'text/html' });
            const textBlob = new Blob([plainText], { type: 'text/plain' });
            navigator.clipboard.write([
                new ClipboardItem({
                    'text/html': blob,
                    'text/plain': textBlob
                })
            ]).then(() => {
                const copyBtn = document.getElementById('sa-copy-btn');
                copyBtn.textContent = '✓ Copied!';
                setTimeout(() => { copyBtn.textContent = '📋 Copy'; }, 2000);
            });
        } catch (e) {
            // Fallback to plain text
            navigator.clipboard.writeText(plainText).then(() => {
                const copyBtn = document.getElementById('sa-copy-btn');
                copyBtn.textContent = '✓ Copied!';
                setTimeout(() => { copyBtn.textContent = '📋 Copy'; }, 2000);
            });
        }
    }

    function buildPlainTextFallback(warehouseId, params, rangeText, typeEntries, totalHours, results, summary, functions, managers) {
        let text = `Indirect Spending Analysis | ${warehouseId} | ${rangeText}\n`;
        text += `${'─'.repeat(50)}\n\n`;
        
        text += `TOTAL: ${totalHours.toFixed(2)} hrs\n`;
        typeEntries.forEach(([typeName, val]) => {
            text += `  ${typeName.padEnd(22)} ${val.hours.toFixed(2)} hrs\n`;
        });
        text += '\n';
        
        if (results.shiftComparison) {
            const sc = results.shiftComparison;
            const shiftLabels = sc.shifts.map(s => s.label);
            const allTypes = new Set();
            sc.shifts.forEach(s => { Object.keys(s.summary.byType || {}).forEach(t => allTypes.add(t)); });
            
            text += `HOURS BY SHIFT\n`;
            text += `  ${'Process'.padEnd(22)}${shiftLabels.map(l => l.padStart(10)).join('')}\n`;
            let totals = shiftLabels.map(() => 0);
            [...allTypes].sort().forEach(typeName => {
                text += `  ${typeName.padEnd(22)}`;
                shiftLabels.forEach((l, i) => {
                    const h = sc.shifts[i].summary.byType[typeName]?.hours || 0;
                    totals[i] += h;
                    text += h.toFixed(2).padStart(10);
                });
                text += '\n';
            });
            text += `  ${'TOTAL'.padEnd(22)}${totals.map(t => t.toFixed(2).padStart(10)).join('')}\n\n`;
        }
        
        if (results.rateMetrics) {
            text += `RATE TO PLAN\n`;
            text += `  ${'Process'.padEnd(22)}${'Act Rate'.padStart(10)}${'LP Rate'.padStart(10)}${'OP Rate'.padStart(10)}${'% LP'.padStart(10)}${'% OP'.padStart(10)}\n`;
            typeEntries.forEach(([typeName]) => {
                const rm = results.rateMetrics[typeName];
                if (!rm) return;
                const actRate = rm.actualRate != null ? rm.actualRate.toFixed(2) : '—';
                const lpRate = rm.lpRate != null ? rm.lpRate.toFixed(2) : '—';
                const opRate = rm.opRate != null ? rm.opRate.toFixed(2) : '—';
                const pctLP = rm.pctToLP != null ? rm.pctToLP.toFixed(2) + '%' : '—';
                const pctOP = rm.pctToOP != null ? rm.pctToOP.toFixed(2) + '%' : '—';
                text += `  ${typeName.padEnd(22)}${actRate.padStart(10)}${lpRate.padStart(10)}${opRate.padStart(10)}${pctLP.padStart(10)}${pctOP.padStart(10)}\n`;
            });
            text += '\n';
        }
        
        if (functions.length > 0) {
            text += `TOP FUNCTIONS\n`;
            functions.forEach(([key, val]) => {
                text += `  ${key.replace(/^.+ - /, '').padEnd(24)} ${val.hours.toFixed(2)} hrs\n`;
            });
            text += '\n';
        }
        
        if (managers.length > 0) {
            text += `TOP 5 MANAGERS\n`;
            managers.forEach(([name, val]) => {
                const bd = Object.entries(val.byType).filter(([,h]) => h > 0).sort((a,b) => b[1]-a[1]).map(([t,h]) => `${t}: ${h.toFixed(2)}`).join(', ');
                text += `  ${name.padEnd(20)} ${val.total.toFixed(2)} hrs  (${bd})\n`;
            });
        }
        return text;
    }

    // ============================================================
    //                    INITIALIZATION
    // ============================================================

    function init() {
        // Wait for page to be ready
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
            return;
        }
        
        injectStyles();
        createUI();
        
        console.log('✅ Indirect Spending Analysis loaded');
    }

    // Start
    setTimeout(init, 1000);

    // Export for testability (Node.js / Vitest environment)
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { findPaidHoursColumnIndex, processPickSupportData, computeReportWeekSunday, isLPCacheValid, computeRateMetrics, getRateColorStyle, buildPPRUrl, fetchPPRData, fetchLPData, toYMD, pad2 };
    }

})();
