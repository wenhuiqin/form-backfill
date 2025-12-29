chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.sync.get(['enabled', 'urlFilter'], (result) => {
        if (result.enabled === undefined) {
            chrome.storage.sync.set({ enabled: true, urlFilter: '' });
        }
    });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'updateConfig') {
        chrome.tabs.query({}, (tabs) => {
            tabs.forEach(tab => {
                chrome.tabs.sendMessage(tab.id, {
                    action: 'configUpdated',
                    config: message.config
                }).catch(() => {});
            });
        });
        sendResponse({ success: true });
    }
    return true;
});
