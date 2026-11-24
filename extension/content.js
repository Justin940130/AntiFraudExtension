/* Content script: bounded request/cache work and explicit per-message lifecycle. */
const API_URL = 'http://127.0.0.1:5000/analyze';
const SELECTORS = {
    'www.messenger.com': 'div[role="presentation"] span[dir="auto"] > div[dir="auto"]',
    'www.instagram.com': 'div[aria-roledescription="message"] span[dir="auto"] > div[dir="auto"]',
    'web.whatsapp.com': 'span.selectable-text'
};
const messageSelector = SELECTORS[window.location.hostname] || '';
const MAX_CACHE_ENTRIES = 500;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CONCURRENT_REQUESTS = 4;
const REQUEST_TIMEOUT_MS = 30000;
const RETRY_DELAYS_MS = [1000, 3000];
const processedElements = new WeakMap();
const observedElements = new Set();
const controls = new WeakMap();
let scanPath = location.pathname;
const visibleElements = new Set();
const resultCache = new Map();
const pendingRequests = new Map();
const dirtyRoots = new Set();
const requestQueue = [];
const metrics = {fullScans: 0, scannedRoots: 0, requests: 0, cacheHits: 0, maxActive: 0};
let activeRequests = 0;
let isReady = false;
let scanTimer = null;
let pointedMessage = null;
const contextEnabled = new Map();
let activeDialog = null;

const style = document.createElement('style');
style.textContent = `
[data-antifraud-risk="high"] {
    background-color: #ffe6e6 !important; color: #222 !important;
    border: 2px solid red !important; border-radius: 8px !important; padding: 5px !important;
}
[data-antifraud-warning]::after {
    content: attr(data-antifraud-warning); display: block;
    font-size: 12px; font-weight: bold; margin-top: 5px; white-space: pre-line;
}
[data-antifraud-risk="high"]::after { color: #b00020; }
[data-antifraud-status="error"]::after,
[data-antifraud-status="skipped"]::after { color: #935500; }
`;
(document.head || document.documentElement).appendChild(style);

function removeControl(el) {
    const button = controls.get(el);
    if (button) {
        controls.delete(el);
        button.remove();
    }
}

function addControl(el, label, retrySeconds = 0) {
    if (controls.get(el)?.isConnected) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    const path = location.pathname;
    const text = currentText(el);
    if (retrySeconds > 0) {
        button.disabled = true;
        button.textContent = label + '（' + retrySeconds + ' 秒後可試）';
        setTimeout(() => {
            button.disabled = false;
            button.textContent = label;
        }, retrySeconds * 1000);
    }
    button.onclick = event => {
        event.stopPropagation();
        event.preventDefault();
        if (!el.isConnected || path !== location.pathname || text !== currentText(el)) return;
        processedElements.delete(el);
        removeControl(el);
        handleMessage(el);
    };
    controls.set(el, button);
    el.after(button);
}

function clearWarning(el) {
    removeControl(el);
    el.removeAttribute('data-antifraud-risk');
    el.removeAttribute('data-antifraud-warning');
    el.removeAttribute('data-antifraud-source');
    el.removeAttribute('data-antifraud-latency-ms');
}

function safetyAdvice(category) {
    if (/驗證碼|憑證|帳密|釣魚|密碼/i.test(category)) return '請勿提供驗證碼或帳密，改由官方 App 或網站查詢。';
    if (/冒充|假冒|親友|身分/i.test(category)) return '先用原有的聯絡方式向本人確認，再決定是否付款。';
    if (/投資|理財|報酬/i.test(category)) return '先停止匯款，透過官方管道查證平台與業者。';
    if (/購物|付款|交易|賣家/i.test(category)) return '留在原交易平台核對訂單及付款資訊。';
    return '先暫停操作，透過可信的聯絡方式獨立查證。';
}

function markMessage(el, result) {
    if (!el.isConnected) return;
    clearWarning(el);
    el.setAttribute('data-antifraud-status', 'done');
    if (result.risk_level === 'high') {
        el.setAttribute('data-antifraud-risk', 'high');
        el.setAttribute('data-antifraud-warning', `⚠ [${result.category}] 系統偵測到高風險內容。${safetyAdvice(result.category)}`);
    }
}

function cachedResult(text) {
    const entry = resultCache.get(text);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
        resultCache.delete(text);
        return null;
    }
    // Refresh LRU order, but do not extend the expiration time.
    resultCache.delete(text);
    resultCache.set(text, entry);
    metrics.cacheHits++;
    return entry.result;
}

function cacheResult(text, result) {
    resultCache.delete(text);
    resultCache.set(text, {result, expiresAt: Date.now() + CACHE_TTL_MS});
    while (resultCache.size > MAX_CACHE_ENTRIES) {
        resultCache.delete(resultCache.keys().next().value);
    }
}

function runQueue() {
    while (activeRequests < MAX_CONCURRENT_REQUESTS && requestQueue.length) {
        const {task, resolve, reject} = requestQueue.shift();
        activeRequests++;
        metrics.maxActive = Math.max(metrics.maxActive, activeRequests);
        Promise.resolve().then(task).then(resolve, reject).finally(() => {
            activeRequests--;
            runQueue();
        });
    }
}

function limitedRequest(task) {
    return new Promise((resolve, reject) => {
        requestQueue.push({task, resolve, reject});
        runQueue();
    });
}

function validateResult(result) {
    if (!result || typeof result !== 'object' || Array.isArray(result) ||
        typeof result.risk_level !== 'string' || typeof result.category !== 'string') {
        throw new Error('Invalid analysis response');
    }
    const risk = result.risk_level.trim().toLowerCase();
    const category = result.category.trim();
    if (!['high', 'medium', 'low'].includes(risk) || !category || [...category].length > 120) {
        throw new Error('Invalid analysis response');
    }
    return {risk_level: risk, category};
}

function analyzeText(text) {
    return requestAnalysis(JSON.stringify(['single', text]), API_URL, {text});
}

function analyzeContext(messages) {
    return requestAnalysis(JSON.stringify(['context-v1', messages]), API_URL + '/context', {messages});
}

async function requestAnalysis(key, url, payload) {
    const cached = cachedResult(key);
    if (cached) return {...cached, source: 'memory'};
    if (pendingRequests.has(key)) {
        const result = await pendingRequests.get(key);
        return {...result, source: 'page-shared'};
    }
    const promise = limitedRequest(async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            metrics.requests++;
            const response = await fetch(url, {
                method: 'POST', headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({id: crypto.randomUUID(), ...payload}), signal: controller.signal
            });
            if (!response.ok) {
                const error = new Error(`HTTP ${response.status}`);
                error.status = response.status;
                error.retrySeconds = Number(response.headers.get('Retry-After')) || 0;
                throw error;
            }
            const body = await response.json();
            const result = validateResult(body);
            if (payload.messages) result.evidence = Array.isArray(body.evidence) ? body.evidence : [];
            cacheResult(key, result);
            return {...result, source: response.headers.get('X-Analysis-Source') || 'backend-unknown'};
        } finally {
            clearTimeout(timeout);
        }
    });
    pendingRequests.set(key, promise);
    try {
        return await promise;
    } finally {
        if (pendingRequests.get(key) === promise) pendingRequests.delete(key);
    }
}

function currentText(el) {
    return (el.innerText || '').trim();
}

function chatScope(el) {
    if (window.location.hostname !== 'www.messenger.com' ||
        !/\/(?:e2ee\/)?t\/[^/]+\/?$/.test(window.location.pathname)) return null;
    const group = el.closest('[role="grid"],[role="log"]');
    return group ? {group, path: window.location.pathname} : null;
}

function collectContext(el) {
    const scope = chatScope(el);
    if (!scope) return [];
    const turns = [...scope.group.querySelectorAll(messageSelector)];
    const index = turns.indexOf(el);
    if (index < 1) return [];
    return turns.slice(Math.max(0, index - 5), index).map(node => ({
        speaker: 'unknown', text: currentText(node)
    })).filter(item => item.text && item.text.length < 1000);
}

const evidenceLabels = {
    claimed_identity: '自稱身分（未驗證）', requested_action: '要求的行動',
    inconsistency: '可能不一致', risk_signal: '風險線索'
};

function evidenceText(result) {
    return result.evidence.filter(entry => evidenceLabels[entry.kind])
        .map(entry => `第 ${entry.message} 則・${evidenceLabels[entry.kind]}：「${entry.quote}」`).join('\n');
}

async function reviewMessage(el, prior, targetSpeaker) {
    const text = currentText(el);
    const path = window.location.pathname;
    const state = processedElements.get(el);
    if (state?.status === 'pending') throw new Error('Initial analysis is pending');
    const keepHigh = el.getAttribute('data-antifraud-risk') === 'high';
    const initialWarning = keepHigh ? el.getAttribute('data-antifraud-warning') : '';
    const ticket = Symbol();
    const isCurrent = () => el.isConnected && window.location.pathname === path &&
        currentText(el) === text && processedElements.get(el) === state && reviewTickets.get(el) === ticket;
    reviewTickets.set(el, ticket);
    el.setAttribute('data-antifraud-warning', '正在複核前文…');
    try {
        const result = await analyzeContext([...prior, {speaker: targetSpeaker, text}]);
        if (isCurrent()) {
            // A downgrade without quoted evidence leaves any initial warning visible.
            if (keepHigh && result.risk_level !== 'high' && !result.evidence.length) {
                el.setAttribute('data-antifraud-warning', initialWarning + ' 複核缺少可核對的原文。');
            } else {
                const riskLabel = {high: '高', medium: '中', low: '低'}[result.risk_level];
                markMessage(el, result);
                const evidence = evidenceText(result);
                const advice = result.risk_level === 'high' ? '\n' + safetyAdvice(result.category) : '';
                el.setAttribute('data-antifraud-warning', `前文複核：${riskLabel}風險・${result.category}${evidence ? '\n' + evidence : ''}${advice}`);
            }
        }
        return result;
    } catch (error) {
        if (isCurrent()) {
            const notice = error.status === 429 ? 'Gemini 達到用量上限，前文複核未完成。' : '前文複核暫未完成。';
            el.setAttribute('data-antifraud-warning', [initialWarning, notice].filter(Boolean).join(' '));
        }
        throw error;
    }
}

const reviewTickets = new WeakMap();

function openContextDialog(el) {
    if (activeDialog || !el?.isConnected) return;
    const text = currentText(el);
    if (!text || text.length >= 1000) return;
    const path = window.location.pathname;
    const host = document.createElement('div');
    const shadow = host.attachShadow({mode: 'closed'});
    const dialog = document.createElement('dialog');
    dialog.style.cssText = 'width:min(580px,90vw);padding:1rem;border:1px solid #666;border-radius:10px;color:#222;background:#fff;font:15px system-ui';
    // Static markup only. All message text is inserted as text or input values.
    dialog.innerHTML = '<h2>防詐：前文複核</h2><p>以下內容會送給 Gemini。請只保留需要的文字，依順序填寫。每行一則，可用「我:」或「對方:」標記。</p><p><b>目標訊息</b>：<span></span></p><label>目標發話方 <select><option value="unknown">不確定</option><option value="other">對方</option><option value="self">我方</option></select></label><p><label>前文（1 到 5 則）<br><textarea rows="6" style="width:96%" maxlength="6000"></textarea></label></p><p role="status"></p><button type="button">送出複核</button> <button type="button">關閉</button>';
    dialog.querySelector('span').textContent = text;
    const scope = chatScope(el);
    if (scope) {
        const toggle = document.createElement('label');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = contextEnabled.get(scope.path) === scope.group;
        checkbox.onchange = () => checkbox.checked
            ? contextEnabled.set(scope.path, scope.group) : contextEnabled.delete(scope.path);
        toggle.append(checkbox, ' 本頁此對話的高風險訊息自動送出近期前文');
        dialog.append(document.createElement('hr'), toggle);
    }
    const input = dialog.querySelector('textarea');
    input.value = collectContext(el).map(turn => turn.text.replace(/\r?\n/g, ' ')).join('\n');
    const status = dialog.querySelector('[role="status"]');
    const [submit, close] = dialog.querySelectorAll('button');
    close.onclick = () => dialog.close();
    dialog.onclose = () => { activeDialog = null; host.remove(); };
    submit.onclick = async () => {
        if (!el.isConnected || window.location.pathname !== path || currentText(el) !== text) {
            status.textContent = '目標已改變，請重新選擇訊息。';
            return;
        }
        if (processedElements.get(el)?.status === 'pending') {
            status.textContent = '單句分析進行中，請等候結果後再複核。';
            return;
        }
        const prior = input.value.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
            const match = line.match(/^(我|對方)\s*[:：]\s*/);
            return {speaker: match ? (match[1] === '我' ? 'self' : 'other') : 'unknown',
                text: (match ? line.slice(match[0].length) : line).trim()};
        });
        if (prior.length < 1 || prior.length > 5 || prior.some(turn => !turn.text || turn.text.length >= 1000)) {
            status.textContent = '請填 1–5 則前文，每則 1–999 個字元單位。';
            return;
        }
        submit.disabled = true;
        status.textContent = '正在複核前文…';
        try {
            const result = await reviewMessage(el, prior, dialog.querySelector('select').value);
            status.style.whiteSpace = 'pre-line';
            status.textContent = `複核結果：${result.risk_level}・${result.category}\n${evidenceText(result)}`;
        } catch (error) {
            status.textContent = error.status === 429 ? 'Gemini 達到用量上限，稍後可再試。' : '前文複核暫未完成。';
        } finally {
            submit.disabled = false;
        }
    };
    shadow.append(dialog);
    activeDialog = dialog;
    document.body.append(host);
    dialog.showModal();
}

function handleMessage(el) {
    if (!isReady || !el.isConnected) return;
    const text = currentText(el);
    const path = window.location.pathname;
    let previous = processedElements.get(el);
    if (previous && (previous.text !== text || previous.path !== path)) {
        clearTimeout(previous.retryTimer);
        clearWarning(el);
        previous = null;
    }
    if (!text || text.length >= 1000) {
        clearWarning(el);
        processedElements.set(el, {text, path, status: 'skipped', attempts: 0});
        el.setAttribute('data-antifraud-status', 'skipped');
        if (text) el.setAttribute('data-antifraud-warning', '訊息過長，尚未分析');
        return;
    }
    if (previous && ['pending', 'done'].includes(previous.status)) return;
    if (previous && previous.status === 'error' &&
        (previous.attempts > RETRY_DELAYS_MS.length || Date.now() < previous.retryAt)) return;
    const state = {text, path, status: 'pending', attempts: (previous?.attempts || 0) + 1, started: previous?.started ?? performance.now()};
    processedElements.set(el, state);
    clearWarning(el);
    el.setAttribute('data-antifraud-status', 'pending');
    analyzeText(text).then(result => {
        if (!el.isConnected || window.location.pathname !== path || processedElements.get(el) !== state) return;
        // Read actual DOM text: a mutation may precede its observer callback.
        if (currentText(el) !== text) { scheduleScan(el); return; }
        state.status = 'done';
        markMessage(el, result);
        el.setAttribute('data-antifraud-source', result.source);
        el.setAttribute('data-antifraud-latency-ms', (performance.now() - state.started).toFixed(1));
        const scope = result.risk_level === 'high' && chatScope(el);
        if (scope && contextEnabled.get(scope.path) === scope.group) {
            const previousTurns = collectContext(el);
            if (previousTurns.length) reviewMessage(el, previousTurns, 'unknown').catch(() => {});
        }
    }).catch(error => {
        if (!el.isConnected || window.location.pathname !== path || processedElements.get(el) !== state) return;
        if (currentText(el) !== text) { scheduleScan(el); return; }
        state.status = 'error';
        if (error.status === 429) {
            state.retryAt = Infinity;
            addControl(el, '重試這一則', error.retrySeconds);
            el.setAttribute('data-antifraud-status', 'error');
            el.setAttribute('data-antifraud-warning', 'Gemini 暫時達到用量上限，這則訊息尚未分析。');
            return;
        }
        const delay = RETRY_DELAYS_MS[state.attempts - 1];
        state.retryAt = Date.now() + (delay || 0);
        el.setAttribute('data-antifraud-status', 'error');
        el.setAttribute('data-antifraud-warning', delay === undefined ?
            '分析暫時無法完成，請勿視為安全（重新整理可再試）' : '分析暫時無法完成，稍後自動重試');
        if (delay !== undefined) {
            state.retryTimer = setTimeout(() => {
                if (processedElements.get(el) === state && visibleElements.has(el)) handleMessage(el);
            }, delay);
        }
    });
}

const visibilityObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
        if (entry.isIntersecting && entry.intersectionRatio >= 0.1) {
            visibleElements.add(entry.target);
            handleMessage(entry.target);
        } else {
            visibleElements.delete(entry.target);
        }
    }
}, {threshold: 0.1});

function trackMessage(el) {
    if (!observedElements.has(el)) {
        observedElements.add(el);
        visibilityObserver.observe(el);
    }
    // An already-visible node can change without another intersection event.
    if (visibleElements.has(el)) handleMessage(el);
}

function scanMessages(roots = [document]) {
    if (!isReady || !messageSelector) return;
    if (scanPath !== location.pathname) {
        scanPath = location.pathname;
        roots = [document];
    }
    for (const root of roots) {
        if (root !== document && !root.isConnected) continue;
        metrics.scannedRoots++;
        if (root === document) metrics.fullScans++;
        if (root.nodeType === 1) {
            const enclosing = root.closest(messageSelector);
            if (enclosing) trackMessage(enclosing);
        }
        if (root.querySelectorAll) root.querySelectorAll(messageSelector).forEach(trackMessage);
    }

}

function scheduleScan(root) {
    if (!root || !isReady) return;
    dirtyRoots.add(root.nodeType === 3 ? root.parentElement : root);
    if (scanTimer !== null) return;
    scanTimer = setTimeout(() => {
        scanTimer = null;
        const roots = [...dirtyRoots].filter(Boolean);
        dirtyRoots.clear();
        // Collapse nested edits so each changed subtree is traversed once.
        const minimal = roots.filter((root, index) =>
            !roots.some((other, otherIndex) => otherIndex !== index && other.contains(root)));
        scanMessages(minimal);
    }, 100);
}

function removeDetachedMessages() {
    for (const el of observedElements) {
        if (!el.isConnected) {
            clearTimeout(processedElements.get(el)?.retryTimer);
            removeControl(el);
            visibilityObserver.unobserve(el);
            observedElements.delete(el);
            visibleElements.delete(el);
            processedElements.delete(el);
        }
    }
}

if (messageSelector) {
    document.addEventListener('pointerdown', event => {
        const message = event.target instanceof Element && event.target.closest(messageSelector);
        if (message) pointedMessage = message;
    }, true);
    document.addEventListener('keydown', event => {
        if (event.altKey && event.shiftKey && event.code === 'KeyR' && pointedMessage?.isConnected) {
            event.preventDefault();
            openContextDialog(pointedMessage);
        }
    }, true);
    const observer = new MutationObserver(records => {
        if (!isReady) return;
        let removed = false;
        for (const record of records) {
            if (record.type === 'characterData') scheduleScan(record.target);
            else {
                // Visit inserted subtrees, not the full chat/body on every mutation.
                for (const node of record.addedNodes) scheduleScan(node);
                const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
                const message = target?.closest(messageSelector);
                if (message) scheduleScan(message);
                removed ||= record.removedNodes.length > 0;
            }
        }
        if (removed) removeDetachedMessages();
    });
    observer.observe(document.body, {childList: true, subtree: true, characterData: true});
    setTimeout(() => {
        isReady = true;
        scanMessages();
    }, 3000);
}
