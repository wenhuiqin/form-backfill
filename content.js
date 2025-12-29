(function() {
    'use strict';
    
    let config = { enabled: true, urlFilter: '' };
    
    function loadConfig() {
        chrome.storage.sync.get(['enabled', 'urlFilter'], (result) => {
            config = {
                enabled: result.enabled !== undefined ? result.enabled : true,
                urlFilter: result.urlFilter || ''
            };
            config.enabled ? injectAPIViewer() : removeAPIViewer();
        });
    }
    
    function injectAPIViewer() {
        if (document.getElementById('api-viewer-injected')) return;
        
        const script = document.createElement('script');
        script.id = 'api-viewer-injected';
        script.src = chrome.runtime.getURL('api-viewer.js');
        script.onload = () => {
            window.postMessage({ type: 'API_VIEWER_CONFIG', config }, '*');
        };
        (document.head || document.documentElement).appendChild(script);
    }
    
    function removeAPIViewer() {
        const injectedScript = document.getElementById('api-viewer-injected');
        if (injectedScript) injectedScript.remove();
        window.postMessage({ type: 'API_VIEWER_DESTROY' }, '*');
    }
    
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'configUpdated') {
            config = message.config;
            if (config.enabled) {
                if (document.getElementById('api-viewer-injected')) {
                    window.postMessage({ 
                        type: 'API_VIEWER_CONFIG', 
                        config,
                        clearClosed: config.clearClosed 
                    }, '*');
                } else {
                    injectAPIViewer();
                }
            } else {
                removeAPIViewer();
            }
            sendResponse({ success: true });
        } else if (message.action === 'initViewer') {
            config = message.config;
            if (config.enabled) injectAPIViewer();
            sendResponse({ success: true });
        }
        return true;
    });
    
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(loadConfig, 100));
    } else {
        setTimeout(loadConfig, 100);
    }
})();
