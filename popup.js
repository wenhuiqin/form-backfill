document.addEventListener('DOMContentLoaded', async () => {
    const enableMonitor = document.getElementById('enableMonitor');
    const urlFilter = document.getElementById('urlFilter');
    const saveBtn = document.getElementById('saveBtn');
    const resetBtn = document.getElementById('resetBtn');
    const statusMessage = document.getElementById('statusMessage');
    const statusIndicator = document.getElementById('statusIndicator');

    async function loadConfig() {
        const config = await chrome.storage.sync.get({ enabled: true, urlFilter: '' });
        enableMonitor.checked = config.enabled;
        urlFilter.value = config.urlFilter;
        urlFilter.disabled = !config.enabled;
        updateStatusIndicator(config.enabled);
    }

    function updateStatusIndicator(enabled) {
        statusIndicator.classList[enabled ? 'remove' : 'add']('disabled');
    }

    function showMessage(message, type = 'success') {
        statusMessage.textContent = message;
        statusMessage.className = `status-message ${type}`;
        statusMessage.style.display = 'block';
        setTimeout(() => statusMessage.style.display = 'none', 3000);
    }

    enableMonitor.addEventListener('change', () => {
        const enabled = enableMonitor.checked;
        urlFilter.disabled = !enabled;
        updateStatusIndicator(enabled);
    });

    saveBtn.addEventListener('click', async () => {
        const enabled = enableMonitor.checked;
        const filter = urlFilter.value.trim();

        if (filter) {
            const urls = filter.split(',').map(u => u.trim()).filter(u => u);
            const invalidUrls = urls.filter(url => {
                if (url.includes('*')) return false;
                if (url.startsWith('http://') || url.startsWith('https://')) return false;
                if (url.startsWith('/')) return false;
                return true;
            });

            if (invalidUrls.length > 0) {
                showMessage('⚠️ URL 格式可能不正确，请检查！', 'error');
                return;
            }
        }

        await chrome.storage.sync.set({ enabled, urlFilter: filter });
        chrome.runtime.sendMessage({
            action: 'updateConfig',
            config: { enabled, urlFilter: filter, clearClosed: true }
        });
        
        window.close();
    });

    resetBtn.addEventListener('click', async () => {
        await chrome.storage.sync.set({ enabled: true, urlFilter: '' });
        chrome.runtime.sendMessage({
            action: 'updateConfig',
            config: { enabled: true, urlFilter: '', clearClosed: true }
        });
        
        window.close();
    });

    await loadConfig();
});
