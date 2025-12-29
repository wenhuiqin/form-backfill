(function() {
    'use strict';
    
    if (window.APIViewerInstance) {
        window.APIViewerInstance.destroy();
    }
    
    const APIViewer = {
        requests: [],
        pinnedPanels: new Map(),
        config: { enabled: true, urlFilter: '' },
        urlPatterns: [],
        
        init() {
            const userClosed = localStorage.getItem('api-viewer-closed') === 'true';
            if (userClosed) return;
            
            this.interceptFetch();
            this.interceptXHR();
            this.createFloatingIcon();
        },
        
        updateConfig(newConfig) {
            this.config = newConfig;
            this.parseUrlPatterns();
            
            const userClosed = localStorage.getItem('api-viewer-closed') === 'true';
            if (userClosed) return;
            
            if (!this.config.enabled) {
                this.destroy();
            } else {
                if (!document.getElementById('api-viewer-float-icon')) {
                    this.createFloatingIcon();
                }
                this.updateFloatingIconBadge();
            }
        },
        
        parseUrlPatterns() {
            if (!this.config.urlFilter || this.config.urlFilter.trim() === '') {
                this.urlPatterns = [];
                return;
            }
            
            this.urlPatterns = this.config.urlFilter
                .split(',')
                .map(pattern => pattern.trim())
                .filter(pattern => pattern.length > 0)
                .map(pattern => {
                    let regexPattern = pattern
                        .replace(/[+?^${}()|[\]\\]/g, '\\$&')
                        .replace(/\*/g, '.*');
                    return new RegExp(regexPattern);
                });
        },
        
        shouldCaptureUrl(url) {
            if (this.urlPatterns.length === 0) return true;
            
            const matched = this.urlPatterns.some(pattern => {
                if (pattern.test(url)) return true;
                
                if (!url.startsWith('http')) {
                    const fullUrl = window.location.origin + url;
                    if (pattern.test(fullUrl)) return true;
                }
                return false;
            });
            
            return matched;
        },
        
        interceptFetch() {
            const self = this;
            const originalFetch = window.fetch;
            
            window.fetch = async function(...args) {
                const [url, options = {}] = args;
                const urlString = typeof url === 'string' ? url : url.toString();
                
                if (!self.config.enabled || !self.shouldCaptureUrl(urlString)) {
                    return originalFetch.apply(this, args);
                }
                
                const requestId = Date.now() + Math.random();
                const requestInfo = {
                    id: requestId,
                    url: urlString,
                    method: options.method || 'GET',
                    headers: options.headers || {},
                    body: options.body,
                    timestamp: new Date().toISOString(),
                    status: null,
                    response: null,
                    responseHeaders: null,
                    error: null,
                    duration: null
                };
                
                const startTime = Date.now();
                
                try {
                    const response = await originalFetch.apply(this, args);
                    const clonedResponse = response.clone();
                    
                    let responseData = null;
                    const contentType = response.headers.get('content-type') || '';
                    
                    if (contentType.includes('application/json')) {
                        try {
                            responseData = await clonedResponse.json();
                        } catch (e) {
                            responseData = await clonedResponse.text();
                        }
                    } else if (contentType.includes('text/')) {
                        responseData = await clonedResponse.text();
                    } else {
                        responseData = '[Binary Data]';
                    }
                    
                    const duration = Date.now() - startTime;
                    
                    requestInfo.status = response.status;
                    requestInfo.response = responseData;
                    requestInfo.responseHeaders = Object.fromEntries(response.headers.entries());
                    requestInfo.duration = duration;
                    requestInfo.success = response.ok;
                    
                    self.addRequest(requestInfo);
                    
                    return response;
                } catch (error) {
                    const duration = Date.now() - startTime;
                    requestInfo.error = error.message;
                    requestInfo.duration = duration;
                    requestInfo.success = false;
                    
                    self.addRequest(requestInfo);
                    throw error;
                }
            };
        },
        
        interceptXHR() {
            const self = this;
            const originalOpen = XMLHttpRequest.prototype.open;
            const originalSend = XMLHttpRequest.prototype.send;
            
            XMLHttpRequest.prototype.open = function(method, url, ...rest) {
                this._apiViewerMethod = method;
                this._apiViewerUrl = url;
                this._apiViewerStartTime = Date.now();
                this._apiViewerRequestId = Date.now() + Math.random();
                this._apiViewerShouldCapture = self.config.enabled && self.shouldCaptureUrl(url);
                
                return originalOpen.apply(this, [method, url, ...rest]);
            };
            
            XMLHttpRequest.prototype.send = function(...args) {
                const xhr = this;
                
                if (!xhr._apiViewerShouldCapture) {
                    return originalSend.apply(this, args);
                }
                
                const requestInfo = {
                    id: xhr._apiViewerRequestId,
                    url: xhr._apiViewerUrl,
                    method: xhr._apiViewerMethod,
                    headers: {},
                    body: args[0],
                    timestamp: new Date().toISOString(),
                    status: null,
                    response: null,
                    responseHeaders: null,
                    error: null,
                    duration: null
                };
                
                xhr.addEventListener('load', function() {
                    const duration = Date.now() - xhr._apiViewerStartTime;
                    let responseData = null;
                    
                    try {
                        const contentType = xhr.getResponseHeader('content-type') || '';
                        if (contentType.includes('application/json')) {
                            responseData = JSON.parse(xhr.responseText);
                        } else {
                            responseData = xhr.responseText;
                        }
                    } catch (e) {
                        responseData = xhr.responseText;
                    }
                    
                    requestInfo.status = xhr.status;
                    requestInfo.response = responseData;
                    requestInfo.duration = duration;
                    requestInfo.success = xhr.status >= 200 && xhr.status < 300;
                    
                    const headers = {};
                    const headerString = xhr.getAllResponseHeaders();
                    if (headerString) {
                        headerString.split('\r\n').forEach(line => {
                            const [key, value] = line.split(': ');
                            if (key && value) headers[key] = value;
                        });
                    }
                    requestInfo.responseHeaders = headers;
                    
                    self.addRequest(requestInfo);
                });
                
                xhr.addEventListener('error', function() {
                    const duration = Date.now() - xhr._apiViewerStartTime;
                    requestInfo.error = 'Network Error';
                    requestInfo.duration = duration;
                    requestInfo.success = false;
                    self.addRequest(requestInfo);
                });
                
                return originalSend.apply(this, args);
            };
        },
        
        addRequest(requestInfo) {
            this.requests.unshift(requestInfo);
            
            if (this.requests.length > 200) {
                this.requests = this.requests.slice(0, 200);
            }
            
            this.updateFloatingIconBadge();
            this.updateRequestList();
            this.updatePinnedPanels(requestInfo);
        },
        
        createFloatingIcon() {
            if (document.getElementById('api-viewer-float-icon')) return;
            
            const icon = document.createElement('div');
            icon.id = 'api-viewer-float-icon';
            icon.style.cssText = `
                position: fixed;
                bottom: 20px;
                right: 20px;
                width: 40px;
                height: 40px;
                background: #333;
                border-radius: 50%;
                box-shadow: 0 2px 8px rgba(0,0,0,0.2);
                cursor: move;
                z-index: 999998;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 18px;
                user-select: none;
                transition: transform 0.2s, background 0.2s;
            `;
            icon.innerHTML = '📡';
            
            const badge = document.createElement('div');
            badge.id = 'api-viewer-badge';
            badge.style.cssText = `
                position: absolute;
                top: -3px;
                right: -3px;
                min-width: 16px;
                height: 16px;
                background: #666;
                color: white;
                border-radius: 8px;
                font-size: 10px;
                font-weight: 600;
                display: none;
                align-items: center;
                justify-content: center;
                padding: 0 4px;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            `;
            badge.textContent = '0';
            icon.appendChild(badge);
            
            let isDragging = false;
            
            icon.onmouseenter = () => {
                if (!isDragging) {
                    icon.style.transform = 'scale(1.1)';
                    icon.style.background = '#444';
                }
            };
            icon.onmouseleave = () => {
                if (!isDragging) {
                    icon.style.transform = 'scale(1)';
                    icon.style.background = '#333';
                }
            };
            
            const self = this;
            icon.onclick = (e) => {
                if (!isDragging) {
                    self.toggleViewerPanel();
                }
            };
            
            document.body.appendChild(icon);
            this.makeDraggableIcon(icon, (dragging) => {
                isDragging = dragging;
            });
        },
        
        updateFloatingIconBadge() {
            const badge = document.getElementById('api-viewer-badge');
            if (badge && this.requests.length > 0) {
                badge.textContent = this.requests.length > 99 ? '99+' : this.requests.length;
                badge.style.display = 'flex';
            }
        },
        
        toggleViewerPanel() {
            const panel = document.getElementById('api-viewer-panel');
            if (panel) {
                panel.remove();
            } else {
                this.createViewerPanel();
                this.updateRequestList();
            }
        },
        
        createViewerPanel() {
            if (document.getElementById('api-viewer-panel')) {
                return;
            }
            
            const panel = document.createElement('div');
            panel.id = 'api-viewer-panel';
            panel.style.cssText = `
                position: fixed;
                top: 20px;
                right: 20px;
                width: 600px;
                max-height: 80vh;
                background: white;
                border: 1px solid #e0e0e0;
                border-radius: 4px;
                box-shadow: 0 2px 10px rgba(0,0,0,0.1);
                z-index: 999999;
                display: flex;
                flex-direction: column;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            `;
            
            panel.innerHTML = `
                <div style="padding: 12px 15px; border-bottom: 1px solid #e0e0e0; display: flex; justify-content: space-between; align-items: center; background: white; cursor: move;" class="drag-handle">
                    <div style="font-weight: 600; font-size: 14px; color: #333;">
                        📡 API 面板
                        <span id="request-count" style="font-size: 12px; color: #999; margin-left: 8px;">(0)</span>
                    </div>
                    <div>
                        <button id="template-btn" style="padding: 4px 10px; margin-right: 5px; background: #ff4d4f; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 12px; font-weight: 500;">
                            📋 模板集
                        </button>
                        <button id="clear-requests" style="padding: 4px 10px; margin-right: 5px; background: white; color: #666; border: 1px solid #ddd; border-radius: 3px; cursor: pointer; font-size: 12px;">
                            清空
                        </button>
                        <button id="toggle-panel" style="padding: 4px 10px; margin-right: 5px; background: white; color: #666; border: 1px solid #ddd; border-radius: 3px; cursor: pointer; font-size: 12px;">
                            收起
                        </button>
                        <button id="close-panel" style="padding: 4px 10px; background: white; color: #666; border: 1px solid #ddd; border-radius: 3px; cursor: pointer; font-size: 12px;">
                            ✕
                        </button>
                    </div>
                </div>
                <div style="padding: 10px; border-bottom: 1px solid #e0e0e0; background: #fafafa;">
                    <input type="text" id="filter-input" placeholder="🔍 搜索请求..." 
                        style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 3px; font-size: 12px;">
                </div>
                <div id="request-list" style="flex: 1; overflow-y: auto; padding: 10px; background: #fafafa;">
                    <div style="text-align: center; color: #999; padding: 20px;">
                        等待API请求...
                    </div>
                </div>
            `;
            
            document.body.appendChild(panel);
            
            const self = this;
            
            // 模板集按钮
            document.getElementById('template-btn').onclick = function() {
                self.showTemplateManager();
            };
            
            document.getElementById('clear-requests').onclick = function() {
                self.requests = [];
                self.updateRequestList();
            };
            
            document.getElementById('toggle-panel').onclick = function() {
                const list = document.getElementById('request-list');
                const filter = list.previousElementSibling;
                const isHidden = list.style.display === 'none';
                list.style.display = isHidden ? 'block' : 'none';
                filter.style.display = isHidden ? 'block' : 'none';
                this.textContent = isHidden ? '收起' : '展开';
            };
            
            document.getElementById('close-panel').onclick = function() {
                panel.remove();
            };
            
            document.getElementById('filter-input').addEventListener('input', function(e) {
                self.filterRequests(e.target.value);
            });
            
            const requestList = document.getElementById('request-list');
            requestList.addEventListener('wheel', function(e) {
                const isAtTop = requestList.scrollTop === 0;
                const isAtBottom = requestList.scrollTop + requestList.clientHeight >= requestList.scrollHeight;
                
                if ((isAtTop && e.deltaY < 0) || (isAtBottom && e.deltaY > 0)) {
                    e.preventDefault();
                }
            });
            
            this.makeDraggable(panel);
        },
        
        updateRequestList(filteredRequests = null) {
            const list = document.getElementById('request-list');
            const count = document.getElementById('request-count');
            
            if (!list || !count) return;
            
            const displayRequests = filteredRequests || this.requests;
            
            if (displayRequests.length === 0) {
                list.innerHTML = '<div style="text-align: center; color: #909399; padding: 20px;">暂无请求</div>';
                count.textContent = '(0)';
                return;
            }
            
            count.textContent = `(${this.requests.length})`;
            
            const self = this;
            list.innerHTML = displayRequests.map(req => {
                const statusColor = req.success ? '#52c41a' : '#ff4d4f';
                const methodColor = {
                    'GET': '#333',
                    'POST': '#333',
                    'PUT': '#666',
                    'DELETE': '#666',
                    'PATCH': '#999'
                }[req.method] || '#333';
                
                const bodyText = req.body ? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body)) : '';
                let bodyDisplay = '';
                if (bodyText) {
                    try {
                        const parsed = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
                        const bodyJson = JSON.stringify(parsed, null, 2);
                        bodyDisplay = `
                            <div style="margin-top: 8px;">
                                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px;">
                                    <strong style="font-size: 12px;">请求体:</strong>
                                    <button onclick="window.APIViewerInstance.showAIParseModal(${self.escapeJson(parsed)})" 
                                        style="padding: 4px 10px; background: #1890ff; color: white; border: none; border-radius: 2px; cursor: pointer; font-size: 11px; font-weight: 500;">
                                        🤖 AI解析
                                    </button>
                                </div>
                                <div style="position: relative; margin-top: 5px;">
                                    <button onclick="window.APIViewerInstance.copyText('${self.escapeHtml(bodyJson)}')" 
                                        style="position: absolute; top: 4px; right: 4px; padding: 4px 6px; background: #666; color: white; border: none; border-radius: 2px; cursor: pointer; font-size: 12px; z-index: 1;">
                                        📋
                                    </button>
                                    <pre style="margin: 0; white-space: pre-wrap; font-size: 11px; max-height: 200px; overflow-y: auto; background: #f5f5f5; padding: 8px 28px 8px 8px; border-radius: 4px;">${bodyJson}</pre>
                                </div>
                            </div>`;
                    } catch (e) {
                        bodyDisplay = `
                            <div style="margin-top: 8px;">
                                <strong style="font-size: 12px;">请求体:</strong>
                                <div style="position: relative; margin-top: 5px;">
                                    <button onclick="window.APIViewerInstance.copyText('${self.escapeHtml(bodyText)}')" 
                                        style="position: absolute; top: 4px; right: 4px; padding: 4px 6px; background: #666; color: white; border: none; border-radius: 2px; cursor: pointer; font-size: 12px; z-index: 1;">
                                        📋
                                    </button>
                                    <pre style="margin: 0; white-space: pre-wrap; font-size: 11px; background: #f5f5f5; padding: 8px 28px 8px 8px; border-radius: 4px;">${bodyText}</pre>
                                </div>
                            </div>`;
                    }
                }
                
                return `
                    <div style="margin-bottom: 10px; padding: 12px; border: 1px solid #e0e0e0; border-radius: 4px; background: #fff;" 
                         onmouseover="this.style.boxShadow='0 2px 8px rgba(0,0,0,0.08)'" 
                         onmouseout="this.style.boxShadow='none'">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <span style="padding: 2px 8px; background: ${methodColor}; color: white; border-radius: 2px; font-size: 11px; font-weight: 600;">
                                    ${req.method}
                                </span>
                                <span style="padding: 2px 8px; background: ${statusColor}; color: white; border-radius: 2px; font-size: 11px;">
                                    ${req.status || 'N/A'}
                                </span>
                                <span style="font-size: 11px; color: #999;">
                                    ${req.duration}ms
                                </span>
                            </div>
                            <div>
                                <button onclick="window.APIViewerInstance.pinRequest(${self.escapeJson(req)})"
                                    style="padding: 3px 8px; background: white; color: #666; border: 1px solid #ddd; border-radius: 2px; cursor: pointer; font-size: 12px; margin-right: 5px;">
                                    📌
                                </button>
                                <button onclick="window.APIViewerInstance.copyRequest(${self.escapeJson(req)})"
                                    style="padding: 3px 8px; background: white; color: #666; border: 1px solid #ddd; border-radius: 2px; cursor: pointer; font-size: 12px;">
                                    📋
                                </button>
                            </div>
                        </div>
                        <div style="font-size: 12px; color: #666; margin-bottom: 5px; word-break: break-all;">
                            <strong>URL:</strong> ${req.url}
                        </div>
                        <div style="font-size: 11px; color: #999;">
                            <strong>时间:</strong> ${new Date(req.timestamp).toLocaleString('zh-CN')}
                        </div>
                        ${bodyDisplay}
                        ${req.error ? `<div style="color: #ff4d4f; font-size: 11px; margin-top: 5px;"><strong>错误:</strong> ${req.error}</div>` : ''}
                        <details style="margin-top: 8px;">
                            <summary style="cursor: pointer; font-size: 12px; color: #333; user-select: none;">
                                查看响应
                            </summary>
                            <div style="margin-top: 8px; position: relative;">
                                <button onclick="window.APIViewerInstance.copyText('${self.escapeHtml(req.response ? JSON.stringify(req.response, null, 2) : '')}')"
                                    style="position: absolute; top: 4px; right: 4px; padding: 4px 6px; background: #666; color: white; border: none; border-radius: 2px; cursor: pointer; font-size: 12px; z-index: 1;">
                                    📋
                                </button>
                                <pre style="margin: 0; padding: 8px 28px 8px 8px; background: #fafafa; border: 1px solid #e0e0e0; border-radius: 3px; font-size: 11px; max-height: 300px; overflow-y: auto; white-space: pre-wrap;">${req.response ? JSON.stringify(req.response, null, 2) : '暂无响应'}</pre>
                            </div>
                        </details>
                    </div>
                `;
            }).join('');
        },
        
        escapeJson(obj) {
            return JSON.stringify(obj).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        },
        
        escapeHtml(str) {
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;')
                .replace(/\n/g, '\\n')
                .replace(/\r/g, '\\r');
        },
        
        copyText(text) {
            const decodedText = text
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'")
                .replace(/\\n/g, '\n')
                .replace(/\\r/g, '\r');
            
            if (navigator.clipboard) {
                navigator.clipboard.writeText(decodedText).then(() => {
                    this.showToast('✅ 已复制到剪贴板');
                }).catch(() => {
                    this.fallbackCopy(decodedText);
                });
            } else {
                this.fallbackCopy(decodedText);
            }
        },
        
        showToast(message) {
            const toast = document.createElement('div');
            toast.textContent = message;
            toast.style.cssText = `
                position: fixed;
                top: 20px;
                left: 50%;
                transform: translateX(-50%);
                background: #333;
                color: white;
                padding: 8px 16px;
                border-radius: 4px;
                font-size: 12px;
                z-index: 10000000;
                opacity: 0;
                transition: opacity 0.3s;
            `;
            document.body.appendChild(toast);
            
            setTimeout(() => toast.style.opacity = '1', 10);
            setTimeout(() => {
                toast.style.opacity = '0';
                setTimeout(() => toast.remove(), 300);
            }, 2000);
        },
        
        filterRequests(keyword) {
            if (!keyword.trim()) {
                this.updateRequestList();
                return;
            }
            
            const filtered = this.requests.filter(req => {
                const searchText = `${req.url} ${req.method} ${req.status}`.toLowerCase();
                return searchText.includes(keyword.toLowerCase());
            });
            
            this.updateRequestList(filtered);
        },
        
        pinRequest(req) {
            const pinnedId = 'pinned-' + req.id;
            
            if (this.pinnedPanels.has(pinnedId)) {
                alert('该请求已经被钉住了！');
                return;
            }
            
            const panel = document.createElement('div');
            panel.className = 'pinned-api-panel';
            panel.id = pinnedId;
            panel.style.cssText = `
                position: fixed;
                top: ${100 + this.pinnedPanels.size * 50}px;
                right: ${650 + this.pinnedPanels.size * 30}px;
                width: 500px;
                height: 500px;
                min-width: 300px;
                min-height: 200px;
                background: white;
                border: 1px solid #333;
                border-radius: 4px;
                box-shadow: 0 2px 8px rgba(0,0,0,0.15);
                z-index: 1000000;
                display: flex;
                flex-direction: column;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                resize: both;
                overflow: hidden;
            `;
            
            const statusColor = req.success ? '#333' : '#666';
            
            panel.innerHTML = `
                <div style="padding: 10px 12px; background: #333; color: white; display: flex; justify-content: space-between; align-items: center; cursor: move;" class="drag-handle">
                    <div style="font-weight: 500; font-size: 13px;">
                        📌 ${req.method} - ${req.status}
                    </div>
                    <button onclick="window.APIViewerInstance.closePinnedPanel('${pinnedId}')"
                        style="background: transparent; color: white; border: none; font-size: 16px; cursor: pointer; padding: 0 4px;">
                        ✕
                    </button>
                </div>
                <div style="flex: 1; overflow-y: auto; padding: 12px; font-size: 12px; background: #fafafa;">
                    <div style="margin-bottom: 10px;">
                        <strong style="color: #333;">方法:</strong> <span style="color: #666;">${req.method}</span>
                    </div>
                    <div style="margin-bottom: 10px;">
                        <strong style="color: #333;">URL:</strong>
                        <div style="background: white; padding: 6px 8px; border-radius: 3px; word-break: break-all; margin-top: 4px; border: 1px solid #ddd; font-size: 11px; color: #666;">
                            ${req.url}
                        </div>
                    </div>
                    <div style="margin-bottom: 10px;">
                        <strong style="color: #333;">状态:</strong> <span style="color: ${statusColor};">${req.status}</span> | 
                        <strong style="color: #333;">耗时:</strong> <span style="color: #666;">${req.duration}ms</span>
                    </div>
                    <div style="margin-bottom: 10px;">
                        <strong style="color: #333;">时间:</strong> <span style="color: #666;">${new Date(req.timestamp).toLocaleString('zh-CN')}</span>
                    </div>
                    ${req.body ? `
                        <div style="margin-bottom: 10px;">
                            <strong style="color: #333;">请求体:</strong>
                            <pre style="background: white; padding: 8px; border-radius: 3px; margin-top: 4px; max-height: 150px; overflow-y: auto; font-size: 10px; border: 1px solid #ddd; color: #666;">${JSON.stringify(typeof req.body === 'string' ? JSON.parse(req.body) : req.body, null, 2)}</pre>
                        </div>
                    ` : ''}
                    ${req.error ? `
                        <div style="margin-bottom: 10px;">
                            <strong style="color: #333;">错误:</strong> <span style="color: #666;">${req.error}</span>
                        </div>
                    ` : ''}
                    <div>
                        <strong style="color: #333;">响应:</strong>
                        <pre style="background: white; padding: 8px; border-radius: 3px; margin-top: 4px; max-height: 250px; overflow-y: auto; font-size: 10px; border: 1px solid #ddd; color: #666;">${req.response ? JSON.stringify(req.response, null, 2) : '暂无响应'}</pre>
                    </div>
                </div>
            `;
            
            document.body.appendChild(panel);
            this.pinnedPanels.set(pinnedId, panel);
            this.makeDraggable(panel);
        },
        
        closePinnedPanel(pannelId) {
            const panel = this.pinnedPanels.get(pannelId);
            if (panel) {
                panel.remove();
                this.pinnedPanels.delete(pannelId);
            }
        },
        
        updatePinnedPanels(newRequest) {},
        
        copyRequest(req) {
            const text = JSON.stringify(req, null, 2);
            
            if (navigator.clipboard) {
                navigator.clipboard.writeText(text).then(() => {
                    alert('✅ 已复制到剪贴板！');
                }).catch(() => {
                    this.fallbackCopy(text);
                });
            } else {
                this.fallbackCopy(text);
            }
        },
        
        fallbackCopy(text) {
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            try {
                document.execCommand('copy');
                alert('✅ 已复制到剪贴板！');
            } catch (err) {
                alert('❌ 复制失败，请手动复制');
            }
            document.body.removeChild(textarea);
        },
        
        makeDraggable(element) {
            const handle = element.querySelector('.drag-handle');
            if (!handle) return;
            
            let isDragging = false;
            let currentX;
            let currentY;
            let initialX;
            let initialY;
            
            handle.addEventListener('mousedown', (e) => {
                isDragging = true;
                initialX = e.clientX - element.offsetLeft;
                initialY = e.clientY - element.offsetTop;
            });
            
            document.addEventListener('mousemove', (e) => {
                if (isDragging) {
                    e.preventDefault();
                    currentX = e.clientX - initialX;
                    currentY = e.clientY - initialY;
                    
                    element.style.left = currentX + 'px';
                    element.style.top = currentY + 'px';
                    element.style.right = 'auto';
                }
            });
            
            document.addEventListener('mouseup', () => {
                isDragging = false;
            });
        },
        
        makeDraggableIcon(element, onDragStateChange) {
            let isDragging = false;
            let hasMoved = false;
            let currentX;
            let currentY;
            let initialX;
            let initialY;
            
            element.addEventListener('mousedown', (e) => {
                isDragging = true;
                hasMoved = false;
                initialX = e.clientX - element.offsetLeft;
                initialY = e.clientY - element.offsetTop;
            });
            
            document.addEventListener('mousemove', (e) => {
                if (isDragging) {
                    e.preventDefault();
                    hasMoved = true;
                    onDragStateChange(true);
                    
                    currentX = e.clientX - initialX;
                    currentY = e.clientY - initialY;
                    
                    element.style.left = currentX + 'px';
                    element.style.top = currentY + 'px';
                    element.style.right = 'auto';
                    element.style.bottom = 'auto';
                }
            });
            
            document.addEventListener('mouseup', () => {
                if (isDragging) {
                    isDragging = false;
                    setTimeout(() => {
                        if (hasMoved) {
                            onDragStateChange(false);
                        }
                    }, 100);
                }
            });
        },
        
        // ========== 模板功能 ==========
        
        // 显示模板管理器
        showTemplateManager() {
            const existing = document.getElementById('template-manager-modal');
            if (existing) existing.remove();
            
            const templates = this.getTemplates();
            
            const modal = document.createElement('div');
            modal.id = 'template-manager-modal';
            modal.style.cssText = `
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                width: 600px;
                max-height: 70vh;
                background: white;
                border: 1px solid #e0e0e0;
                border-radius: 8px;
                box-shadow: 0 4px 20px rgba(0,0,0,0.15);
                z-index: 10000000;
                display: flex;
                flex-direction: column;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            `;
            
            const templatesHTML = templates.length === 0 
                ? '<div style="text-align: center; color: #999; padding: 40px;">暂无模板</div>'
                : templates.map((tpl, index) => `
                    <div style="padding: 12px; border-bottom: 1px solid #f0f0f0; display: flex; justify-content: space-between; align-items: center;" 
                         onmouseover="this.style.background='#f5f5f5'" 
                         onmouseout="this.style.background='white'">
                        <div style="flex: 1; cursor: pointer;" onclick="window.APIViewerInstance.viewTemplateDetail(${index})">
                            <div style="font-weight: 500; font-size: 13px; margin-bottom: 4px;">${this.escapeHtml(tpl.name)}</div>
                            <div style="font-size: 11px; color: #999;">
                                ${tpl.mappings.length} 个字段 · ${new Date(tpl.createdAt).toLocaleString()}
                            </div>
                        </div>
                        <div>
                            <button onclick="event.stopPropagation(); window.APIViewerInstance.applyTemplate(${index})" 
                                style="padding: 4px 12px; margin-right: 5px; background: #52c41a; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 12px;">
                                应用
                            </button>
                            <button onclick="event.stopPropagation(); window.APIViewerInstance.deleteTemplate(${index})" 
                                style="padding: 4px 12px; background: #ff4d4f; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 12px;">
                                删除
                            </button>
                        </div>
                    </div>
                `).join('');
            
            modal.innerHTML = `
                <div style="padding: 15px 20px; border-bottom: 1px solid #e0e0e0; display: flex; justify-content: space-between; align-items: center;">
                    <div style="font-weight: 600; font-size: 15px;">📋 表单模板集</div>
                    <div>
                        <button onclick="window.APIViewerInstance.showCreateTemplateModal()" 
                            style="padding: 6px 12px; margin-right: 10px; background: #1890ff; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 12px;">
                            + 新增模板
                        </button>
                        <button onclick="document.getElementById('template-manager-modal').remove()" 
                            style="padding: 4px 10px; background: white; color: #666; border: 1px solid #ddd; border-radius: 3px; cursor: pointer; font-size: 12px;">
                            ✕
                        </button>
                    </div>
                </div>
                <div style="flex: 1; overflow-y: auto;">
                    ${templatesHTML}
                </div>
            `;
            
            document.body.appendChild(modal);
        },
        
        // 获取所有模板
        getTemplates() {
            const templatesJson = localStorage.getItem('api-viewer-templates');
            return templatesJson ? JSON.parse(templatesJson) : [];
        },
        
        // 保存模板
        saveTemplate(template) {
            const templates = this.getTemplates();
            templates.unshift(template);
            localStorage.setItem('api-viewer-templates', JSON.stringify(templates));
        },
        
        // 应用模板
        applyTemplate(index) {
            const templates = this.getTemplates();
            const template = templates[index];
                            
            if (!template) {
                alert('模板不存在');
                return;
            }
                    
            console.log('🔍 === 开始应用模板 ===');
            console.log('📋 模板名称:', template.name);
            console.log('📊 模板映射数量:', template.mappings.length);
            console.log('📝 模板映射详情:', template.mappings.map(m => `${m.formLabel} -> ${m.requestField} = ${m.value}`));
                    
            // 先关闭模板管理器,让表单可见
            const modal = document.getElementById('template-manager-modal');
            if (modal) modal.remove();
                    
            // 等待DOM更新后再提取表单字段
            setTimeout(() => {
                // 提取表单字段
                const formFields = this.extractFormFields();
                        
                console.log('✅ 当前页面表单字段数量:', formFields.length);
                console.log('📋 当前页面字段列表:', formFields.map(f => f.label));
                                
                if (formFields.length === 0) {
                    alert('❗ 未找到表单字段,请确保当前页面有表单');
                    return;
                }
                        
                this._applyMappingsToForm(template, formFields);
            }, 100);
        },
                
        // 应用映射到表单(内部方法)
        _applyMappingsToForm(template, formFields) {
            // 根据模板映射填充表单
            let successCount = 0;
            let failCount = 0;
            let totalMappings = template.mappings.length;
            
            // 记录未找到的字段(可能是动态字段),等待二次回填
            const pendingMappings = [];
                    
            console.log('🚀 开始匹配并填充...');
                            
            template.mappings.forEach((mapping, idx) => {
                console.log(`\n--- 处理第 ${idx + 1}/${totalMappings} 个映射 ---`);
                console.log('🔍 查找表单字段:', mapping.formLabel);
                        
                // 找到对应的表单字段
                const field = formFields.find(f => f.label === mapping.formLabel);
                        
                if (!field) {
                    console.warn(`⚠️ 未找到表单字段: "${mapping.formLabel}" (可能是动态字段,等待二次回填)`);
                    // 加入pending列表,等待二次回填
                    pendingMappings.push(mapping);
                    return;
                }
                        
                console.log('✅ 找到字段:', field.label, '类型:', field.type);
                        
                try {
                    const element = field.element;
                    const container = field.container;
                    const value = mapping.value;
                            
                    if (element && element instanceof HTMLElement) {
                        // 判断组件类型
                        const elSelectWrapper = container.querySelector('.el-select');
                        const antSelectWrapper = container.querySelector('.ant-select');
                        const antRadioGroup = container.querySelector('.ant-radio-group');
                        const antCheckboxGroup = container.querySelector('.ant-checkbox-group');
                        const antDatePicker = container.querySelector('.ant-picker');
                        const fusionNumberPicker = container.querySelector('.next-number-picker'); // Fusion Design NumberPicker
                        
                        console.log('🔍 组件检测:', {
                            elSelect: !!elSelectWrapper,
                            antSelect: !!antSelectWrapper,
                            antRadio: !!antRadioGroup,
                            antCheckbox: !!antCheckboxGroup,
                            antDatePicker: !!antDatePicker,
                            fusionNumberPicker: !!fusionNumberPicker,
                            containerHTML: container.innerHTML.substring(0, 200)
                        });
                        
                        // 打印实际进入的分支
                        let branchName = 'unknown';
                        if (antDatePicker) branchName = 'DatePicker';
                        else if (fusionNumberPicker) branchName = 'Fusion NumberPicker';
                        else if (antRadioGroup) branchName = 'Radio';
                        else if (antCheckboxGroup) branchName = 'Checkbox';
                        else if (elSelectWrapper) branchName = 'Element UI Select';
                        else if (antSelectWrapper) branchName = 'Ant Design Select';
                        else branchName = '普通输入框';
                        console.log('➡️ 进入分支:', branchName);
                                            
                        // 格式化值
                        let formattedValue = value;
                                            
                        // 日期格式化
                        if (antDatePicker && typeof value === 'string' && value.includes('T')) {
                            // 处理ISO格式日期
                            const date = new Date(value);
                            formattedValue = date.toISOString().split('T')[0]; // YYYY-MM-DD
                            console.log(`📅 日期格式化: ${value} -> ${formattedValue}`);
                        }
                        
                        if (antDatePicker) {
                            // Ant Design DatePicker 特殊处理 - 必须通过点击选择日期
                            console.log('📅 DatePicker 填充, 值:', formattedValue);
                            
                            const input = antDatePicker.querySelector('input');
                            if (input) {
                                // 点击 input 打开日历
                                input.click();
                                input.focus();
                                
                                // 等待日历打开
                                setTimeout(() => {
                                    const picker = document.querySelector('.ant-picker-dropdown:not(.ant-picker-dropdown-hidden)');
                                    
                                    if (picker) {
                                        console.log('📅 日历打开成功!');
                                        
                                        // 解析日期
                                        const targetDate = new Date(formattedValue);
                                        const targetYear = targetDate.getFullYear();
                                        const targetMonth = targetDate.getMonth(); // 0-11
                                        const targetDay = targetDate.getDate();
                                        
                                        console.log(`📅 目标日期: ${targetYear}-${targetMonth + 1}-${targetDay}`);
                                        
                                        // 查找并点击对应的日期单元格
                                        const cells = picker.querySelectorAll('.ant-picker-cell:not(.ant-picker-cell-disabled)');
                                        let clicked = false;
                                        
                                        cells.forEach(cell => {
                                            const cellTitle = cell.getAttribute('title'); // 例如: "2025-12-21"
                                            const cellText = cell.querySelector('.ant-picker-cell-inner')?.textContent.trim();
                                            
                                            // 匹配title或者天数
                                            if ((cellTitle && cellTitle === formattedValue) || 
                                                (cellText === String(targetDay) && !clicked)) {
                                                cell.click();
                                                clicked = true;
                                                console.log(`✅ 点击日期单元格: ${cellTitle || cellText}`);
                                            }
                                        });
                                        
                                        if (!clicked) {
                                            console.warn(`⚠️ 未找到日期 ${formattedValue} 的单元格`);
                                            // 关闭日历
                                            document.body.click();
                                            failCount++;
                                        } else {
                                            successCount++;
                                        }
                                    } else {
                                        console.error('❌ 日历未打开');
                                        failCount++;
                                    }
                                }, 300); // 等待300ms让日历弹出
                            } else {
                                console.error('❌ DatePicker中未找到input元素');
                                failCount++;
                            }
                        } else if (fusionNumberPicker) {
                            // Fusion Design NumberPicker - 特殊处理
                            console.log('🔢 Fusion NumberPicker 填充, 值:', formattedValue);
                            
                            // 找到input元素
                            const input = fusionNumberPicker.querySelector('input');
                            if (input) {
                                const valueToSet = String(formattedValue);
                                
                                // 通过原生setter设置值
                                const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                                nativeInputValueSetter.call(input, valueToSet);
                                
                                // 触发React事件
                                const inputEvent = new InputEvent('input', { bubbles: true, cancelable: true, composed: true });
                                const changeEvent = new Event('change', { bubbles: true, cancelable: true });
                                const blurEvent = new Event('blur', { bubbles: true });
                                
                                input.dispatchEvent(inputEvent);
                                input.dispatchEvent(changeEvent);
                                input.dispatchEvent(blurEvent);
                                
                                console.log('✅ NumberPicker填充成功:', valueToSet);
                                successCount++;
                            } else {
                                console.error('❌ NumberPicker中未找到input元素');
                                failCount++;
                            }
                        } else if (antRadioGroup) {
                            // Ant Design Radio 单选框
                            const radios = antRadioGroup.querySelectorAll('input[type="radio"]');
                            let found = false;
                                                
                            radios.forEach(radio => {
                                const radioLabel = radio.closest('.ant-radio-wrapper');
                                const labelText = radioLabel ? radioLabel.textContent.trim() : '';
                                                    
                                if (labelText === formattedValue || labelText === String(formattedValue)) {
                                    radio.click();
                                    found = true;
                                    console.log(`🔘 Radio选中: ${labelText}`);
                                }
                            });
                                                
                            if (found) {
                                successCount++;
                            } else {
                                console.warn(`Radio 未找到匹配选项: ${formattedValue}`);
                                failCount++;
                            }
                        } else if (antCheckboxGroup) {
                            // Ant Design Checkbox 复选框
                            const checkboxes = antCheckboxGroup.querySelectorAll('input[type="checkbox"]');
                            const valuesToCheck = Array.isArray(formattedValue) ? formattedValue : [formattedValue];
                            let checkedCount = 0;
                                                
                            checkboxes.forEach(checkbox => {
                                const checkboxLabel = checkbox.closest('.ant-checkbox-wrapper');
                                const labelText = checkboxLabel ? checkboxLabel.textContent.trim() : '';
                                                    
                                if (valuesToCheck.some(v => labelText === v || labelText === String(v))) {
                                    checkbox.click();
                                    checkedCount++;
                                    console.log(`☑️ Checkbox选中: ${labelText}`);
                                }
                            });
                                                
                            if (checkedCount > 0) {
                                successCount++;
                            } else {
                                console.warn(`Checkbox 未找到匹配选项: ${formattedValue}`);
                                failCount++;
                            }
                        } else if (elSelectWrapper) {
                            // Element UI Select特殊处理
                            elSelectWrapper.click();
                                                
                            setTimeout(() => {
                                const dropdown = document.querySelector('.el-select-dropdown:not(.is-hidden)');
                                if (dropdown) {
                                    const options = dropdown.querySelectorAll('.el-select-dropdown__item');
                                    let found = false;
                                                        
                                    options.forEach(option => {
                                        const optionText = option.textContent.trim();
                                        if (optionText === value || optionText === String(value)) {
                                            option.click();
                                            found = true;
                                        }
                                    });
                                                        
                                    if (found) {
                                        successCount++;
                                    } else {
                                        console.warn(`Element UI Select 未找到匹配选项: ${value}`);
                                        failCount++;
                                    }
                                } else {
                                    element.value = typeof value === 'object' ? JSON.stringify(value, null, 2) : value;
                                    const vueInstance = element.__vue__ || element.parentElement?.__vue__;
                                    if (vueInstance) {
                                        vueInstance.$emit('input', element.value);
                                        vueInstance.$emit('change', element.value);
                                    }
                                    element.dispatchEvent(new Event('input', { bubbles: true }));
                                    element.dispatchEvent(new Event('change', { bubbles: true }));
                                    successCount++;
                                }
                            }, idx * 150);
                        } else if (antSelectWrapper) {
                            // Ant Design Select特殊处理
                            antSelectWrapper.click();
                                                
                            setTimeout(() => {
                                const dropdown = document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden)');
                                if (dropdown) {
                                    const options = dropdown.querySelectorAll('.ant-select-item-option');
                                    let found = false;
                                                        
                                    options.forEach(option => {
                                        const optionText = option.textContent.trim();
                                        if (optionText === value || optionText === String(value)) {
                                            option.click();
                                            found = true;
                                        }
                                    });
                                                        
                                    if (found) {
                                        successCount++;
                                    } else {
                                        console.warn(`Ant Design Select 未找到匹配选项: ${value}`);
                                        failCount++;
                                    }
                                } else {
                                    element.value = typeof value === 'object' ? JSON.stringify(value, null, 2) : value;
                                    element.dispatchEvent(new Event('input', { bubbles: true }));
                                    element.dispatchEvent(new Event('change', { bubbles: true }));
                                    successCount++;
                                }
                            }, idx * 150);
                        } else {
                            // 普通输入框(包括日期输入框)
                            console.log('📝 开始填充普通输入框, 值:', formattedValue);
                            console.log('🔍 输入框类型:', element.type, '标签名:', element.tagName);
                            console.log('🔍 输入框class:', element.className);
                                                    
                            // 设置值
                            const valueToSet = typeof formattedValue === 'object' ? JSON.stringify(formattedValue, null, 2) : String(formattedValue);
                                                    
                            // 方法1: 通过原生setter触发React更新
                            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                            nativeInputValueSetter.call(element, valueToSet);
                                                    
                            // 方法2: 创建真实的用户输入事件(React专用)
                            const inputEvent = new InputEvent('input', {
                                bubbles: true,
                                cancelable: true,
                                composed: true
                            });
                                                    
                            const changeEvent = new Event('change', {
                                bubbles: true,
                                cancelable: true
                            });
                                                    
                            // 触发事件
                            element.dispatchEvent(inputEvent);
                            element.dispatchEvent(changeEvent);
                                                    
                            // 方法3: 如果还不行,尝试blur事件
                            const blurEvent = new Event('blur', { bubbles: true });
                            element.dispatchEvent(blurEvent);
                                                    
                            console.log('✅ 设置 element.value =', element.value);
                            console.log('✅ 触发事件完成 (input + change + blur)');
                                                    
                            successCount++;
                                                    
                            console.log(`✅ 普通输入框填充成功! successCount = ${successCount}`);
                        }
                    }
                } catch (error) {
                    console.error('填充失败:', error);
                    failCount++;
                }
            });
            
            // 二次回填: 处理动态字段
            if (pendingMappings.length > 0) {
                console.log(`\n🔄 发现 ${pendingMappings.length} 个动态字段,等待1秒后二次回填...`);
                console.log('📋 动态字段列表:', pendingMappings.map(m => m.formLabel));
                
                setTimeout(() => {
                    console.log('\n🔄 === 开始二次回填 ===');
                    
                    // 重新提取表单字段(现在应该包含动态字段了)
                    const updatedFormFields = this.extractFormFields();
                    console.log('✅ 重新提取到表单字段:', updatedFormFields.length);
                    
                    let secondSuccessCount = 0;
                    let secondFailCount = 0;
                    
                    pendingMappings.forEach((mapping, idx) => {
                        console.log(`\n--- 二次回填 ${idx + 1}/${pendingMappings.length} ---`);
                        console.log('🔍 查找表单字段:', mapping.formLabel);
                        
                        const field = updatedFormFields.find(f => f.label === mapping.formLabel);
                        
                        if (!field) {
                            console.error(`❌ 仍未找到字段: "${mapping.formLabel}"`);
                            secondFailCount++;
                            return;
                        }
                        
                        console.log('✅ 找到字段:', field.label);
                        
                        // 直接填充(复用普通输入框逻辑)
                        try {
                            const element = field.element;
                            const value = mapping.value;
                            const valueToSet = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
                            
                            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                            nativeInputValueSetter.call(element, valueToSet);
                            
                            const inputEvent = new InputEvent('input', { bubbles: true, cancelable: true, composed: true });
                            const changeEvent = new Event('change', { bubbles: true, cancelable: true });
                            const blurEvent = new Event('blur', { bubbles: true });
                            
                            element.dispatchEvent(inputEvent);
                            element.dispatchEvent(changeEvent);
                            element.dispatchEvent(blurEvent);
                            
                            console.log('✅ 二次回填成功:', field.label, '=', valueToSet);
                            secondSuccessCount++;
                        } catch (error) {
                            console.error('二次回填失败:', error);
                            secondFailCount++;
                        }
                    });
                    
                    // 显示总结果
                    const totalSuccess = successCount + secondSuccessCount;
                    const totalFail = failCount + secondFailCount;
                    
                    console.log(`\n🎉 === 回填完成 ===`);
                    console.log(`✅ 总成功: ${totalSuccess} 个字段 (首次${successCount} + 二次${secondSuccessCount})`);
                    if (totalFail > 0) {
                        console.log(`❌ 总失败: ${totalFail} 个字段`);
                    }
                }, 1000); // 等待1秒,让动态字段充分渲染
            } else {
                // 没有pending字段,直接显示结果
                console.log(`\n🎉 回填完成! 成功: ${successCount}, 失败: ${failCount}`);
            }
        },
        
       // 删除模板
        deleteTemplate(index) {
            if (!confirm('确认删除该模板?')) return;
                   
            const templates = this.getTemplates();
            templates.splice(index, 1);
            localStorage.setItem('api-viewer-templates', JSON.stringify(templates));
                   
            // 刷新显示
            this.showTemplateManager();
        },
               
        // 查看模板详情
        viewTemplateDetail(index) {
            const templates = this.getTemplates();
            const template = templates[index];
                   
            if (!template) {
                alert('模板不存在');
                return;
            }
                   
            // 获取当前表单字段用于自动完成
            const formFields = this.extractFormFields();
            const formLabels = formFields.map(f => f.label);
                   
            this.showTemplateEditModal(template, index, formLabels);
        },
               
        // 显示新增模板弹窗
        showCreateTemplateModal() {
            const formFields = this.extractFormFields();
                   
            if (formFields.length === 0) {
                alert('❗ 未找到表单字段,请先打开包含表单的页面');
                return;
            }
                   
            const formLabels = formFields.map(f => f.label);
                   
            // 创建空模板
            const emptyTemplate = {
                name: '',
                mappings: [],
                createdAt: Date.now()
            };
                   
            this.showTemplateEditModal(emptyTemplate, -1, formLabels);
        },
               
        // 显示模板编辑弹窗
        showTemplateEditModal(template, templateIndex, formLabels = []) {
            const existing = document.getElementById('template-edit-modal');
            if (existing) existing.remove();
                   
            const isNew = templateIndex === -1;
            const mappings = template.mappings || [];
                   
            const modal = document.createElement('div');
            modal.id = 'template-edit-modal';
            modal.style.cssText = `
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                width: 700px;
                max-height: 80vh;
                background: white;
                border: 1px solid #e0e0e0;
                border-radius: 8px;
                box-shadow: 0 4px 20px rgba(0,0,0,0.15);
                z-index: 10000001;
                display: flex;
                flex-direction: column;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            `;
                   
            // 表单字段下拉选项
            const formLabelOptions = formLabels.map(label => `<option value="${this.escapeHtml(label)}">`).join('');
                   
            // 映射列表HTML
            const mappingsHTML = mappings.map((m, index) => `
                <div class="mapping-row" data-index="${index}" style="padding: 12px; border-bottom: 1px solid #f0f0f0; display: flex; align-items: center; gap: 10px;">
                    <div style="flex: 1;">
                        <div style="font-size: 12px; color: #666; margin-bottom: 4px;">表单字段:</div>
                        <input type="text" class="form-label-input" value="${this.escapeHtml(m.formLabel)}" list="form-labels-list"
                            style="width: 100%; padding: 6px; border: 1px solid #ddd; border-radius: 3px; font-size: 12px;">
                    </div>
                    <div style="padding-top: 20px; color: #999;">→</div>
                    <div style="flex: 1;">
                        <div style="font-size: 12px; color: #666; margin-bottom: 4px;">请求字段:</div>
                        <input type="text" class="request-field-input" value="${this.escapeHtml(m.requestField)}"
                            style="width: 100%; padding: 6px; border: 1px solid #ddd; border-radius: 3px; font-size: 12px;">
                    </div>
                    <div style="flex: 1;">
                        <div style="font-size: 12px; color: #666; margin-bottom: 4px;">值:</div>
                        <input type="text" class="value-input" value="${this.escapeHtml(String(m.value))}"
                            style="width: 100%; padding: 6px; border: 1px solid #ddd; border-radius: 3px; font-size: 12px;">
                    </div>
                    <button onclick="this.parentElement.remove()" 
                        style="padding: 6px 10px; margin-top: 20px; background: #ff4d4f; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 12px;">
                        ✕
                    </button>
                </div>
            `).join('');
                   
            modal.innerHTML = `
                <div style="padding: 15px 20px; border-bottom: 1px solid #e0e0e0; display: flex; justify-content: space-between; align-items: center;">
                    <div style="font-weight: 600; font-size: 15px;">${isNew ? '➕ 新增模板' : '✏️ 编辑模板'}</div>
                    <button onclick="document.getElementById('template-edit-modal').remove()" 
                        style="padding: 4px 10px; background: white; color: #666; border: 1px solid #ddd; border-radius: 3px; cursor: pointer; font-size: 12px;">
                        ✕
                    </button>
                </div>
                       
                <div style="padding: 15px 20px; border-bottom: 1px solid #f0f0f0;">
                    <div style="font-size: 12px; color: #666; margin-bottom: 6px;">模板名称:</div>
                    <input type="text" id="template-name-input" value="${this.escapeHtml(template.name)}" placeholder="输入模板名称"
                        style="width: 100%; padding: 8px 12px; border: 1px solid #ddd; border-radius: 3px; font-size: 13px;">
                </div>
                       
                <div style="flex: 1; overflow-y: auto;" id="mappings-container">
                    ${mappingsHTML}
                    ${mappings.length === 0 ? '<div style="text-align: center; color: #999; padding: 40px;">暂无字段映射,点击下方"添加字段"按钮</div>' : ''}
                </div>
                       
                <datalist id="form-labels-list">
                    ${formLabelOptions}
                </datalist>
                       
                <div style="padding: 15px 20px; border-top: 1px solid #e0e0e0; display: flex; justify-content: space-between; gap: 10px;">
                    <button onclick="window.APIViewerInstance.addMappingRow()" 
                        style="padding: 8px 16px; background: #faad14; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 13px;">
                        + 添加字段
                    </button>
                    <div>
                        <button onclick="document.getElementById('template-edit-modal').remove()" 
                            style="padding: 8px 16px; margin-right: 10px; background: #d9d9d9; color: #666; border: none; border-radius: 3px; cursor: pointer; font-size: 13px;">
                            取消
                        </button>
                        <button onclick="window.APIViewerInstance.saveTemplateEdit(${templateIndex})" 
                            style="padding: 8px 16px; background: #52c41a; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 13px;">
                            保存
                        </button>
                    </div>
                </div>
            `;
                   
            document.body.appendChild(modal);
        },
               
        // 添加映射行
        addMappingRow() {
            const container = document.getElementById('mappings-container');
            if (!container) return;
                   
            // 移除空提示
            const emptyTip = container.querySelector('[style*="暂无字段映射"]');
            if (emptyTip) emptyTip.remove();
                   
            const index = container.querySelectorAll('.mapping-row').length;
                   
            const row = document.createElement('div');
            row.className = 'mapping-row';
            row.dataset.index = index;
            row.style.cssText = 'padding: 12px; border-bottom: 1px solid #f0f0f0; display: flex; align-items: center; gap: 10px;';
                   
            row.innerHTML = `
                <div style="flex: 1;">
                    <div style="font-size: 12px; color: #666; margin-bottom: 4px;">表单字段:</div>
                    <input type="text" class="form-label-input" list="form-labels-list" placeholder="输入表单字段名"
                        style="width: 100%; padding: 6px; border: 1px solid #ddd; border-radius: 3px; font-size: 12px;">
                </div>
                <div style="padding-top: 20px; color: #999;">→</div>
                <div style="flex: 1;">
                    <div style="font-size: 12px; color: #666; margin-bottom: 4px;">请求字段:</div>
                    <input type="text" class="request-field-input" placeholder="输入请求字段名"
                        style="width: 100%; padding: 6px; border: 1px solid #ddd; border-radius: 3px; font-size: 12px;">
                </div>
                <div style="flex: 1;">
                    <div style="font-size: 12px; color: #666; margin-bottom: 4px;">值:</div>
                    <input type="text" class="value-input" placeholder="默认值(可选)"
                        style="width: 100%; padding: 6px; border: 1px solid #ddd; border-radius: 3px; font-size: 12px;">
                </div>
                <button onclick="this.parentElement.remove()" 
                    style="padding: 6px 10px; margin-top: 20px; background: #ff4d4f; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 12px;">
                    ✕
                </button>
            `;
                   
            container.appendChild(row);
        },
               
        // 保存模板编辑
        saveTemplateEdit(templateIndex) {
            const nameInput = document.getElementById('template-name-input');
            const templateName = nameInput ? nameInput.value.trim() : '';
                   
            if (!templateName) {
                alert('❗ 请输入模板名称');
                return;
            }
                   
            // 收集所有映射
            const mappingRows = document.querySelectorAll('.mapping-row');
            const mappings = [];
                   
            mappingRows.forEach(row => {
                const formLabel = row.querySelector('.form-label-input')?.value.trim();
                const requestField = row.querySelector('.request-field-input')?.value.trim();
                const value = row.querySelector('.value-input')?.value.trim();
                       
                if (formLabel && requestField) {
                    mappings.push({
                        formLabel,
                        requestField,
                        value: value || ''
                    });
                }
            });
                   
            if (mappings.length === 0) {
                alert('❗ 请至少添加一个字段映射');
                return;
            }
                   
            const template = {
                name: templateName,
                mappings: mappings,
                createdAt: Date.now()
            };
                   
            const templates = this.getTemplates();
                   
            if (templateIndex === -1) {
                // 新增
                templates.unshift(template);
            } else {
                // 更新
                templates[templateIndex] = template;
            }
                   
            localStorage.setItem('api-viewer-templates', JSON.stringify(templates));
                   
            // 关闭编辑弹窗
            const editModal = document.getElementById('template-edit-modal');
            if (editModal) editModal.remove();
                   
            alert('✅ 模板保存成功!');
                   
            // 刷新模板管理器
            this.showTemplateManager();
        },
        
        // 提取表单字段
        extractFormFields() {
            const fields = [];
                
            // 尝试提取Element UI表单
            const elFormItems = document.querySelectorAll('.el-form-item');
            console.log('🔍 找到 Element UI 表单项:', elFormItems.length);
                
            elFormItems.forEach((item, index) => {
                const labelEl = item.querySelector('.el-form-item__label');
                const label = labelEl ? labelEl.textContent.trim().replace(/[*:]+$/, '').trim() : '';
                    
                const input = item.querySelector('input:not([type="hidden"])');
                const select = item.querySelector('.el-select input');
                const textarea = item.querySelector('textarea');
                const inputEl = input || select || textarea;
                    
                if (inputEl && label) {
                    fields.push({
                        label: label,
                        element: inputEl,
                        container: item,
                        index: index,
                        type: 'element-ui'
                    });
                }
            });
                
            // 尝试提取Ant Design表单
            const antFormItems = document.querySelectorAll('.ant-form-item');
            console.log('🔍 找到 Ant Design 表单项:', antFormItems.length);
                
            antFormItems.forEach((item, index) => {
                const labelEl = item.querySelector('.ant-form-item-label label');
                const label = labelEl ? labelEl.textContent.trim().replace(/[*:]+$/, '').trim() : '';
                    
                // Ant Design的输入框
                const input = item.querySelector('.ant-input:not([type="hidden"])');
                const select = item.querySelector('.ant-select input');
                const textarea = item.querySelector('.ant-input textarea');
                const checkbox = item.querySelector('.ant-checkbox-wrapper input');
                const radio = item.querySelector('.ant-radio-wrapper input');
                const datePicker = item.querySelector('.ant-picker input');
                // Fusion Design NumberPicker
                const numberPicker = item.querySelector('.next-number-picker input');
                    
                const inputEl = input || select || textarea || checkbox || radio || datePicker || numberPicker;
                    
                if (inputEl && label) {
                    fields.push({
                        label: label,
                        element: inputEl,
                        container: item,
                        index: index,
                        type: 'ant-design'
                    });
                }
            });
                
            console.log('✅ 总共提取到表单字段:', fields.length);
            console.log('📋 字段列表:', fields.map(f => `${f.label} (${f.type})`));
                    
            return fields;
        },
        
        // 显示AI解析弹窗
        async showAIParseModal(requestData) {
            const existing = document.getElementById('ai-parse-modal');
            if (existing) existing.remove();
            
            // 提取表单字段
            const formFields = this.extractFormFields();
            
            if (formFields.length === 0) {
                alert('❗ 未找到表单字段');
                return;
            }
            
            // 显示加载中
            this.showToast('🤖 AI解析中...');
            
            try {
                // 调用AI解析(内置默认配置)
                const mappings = await this.callAIForParsing(requestData, formFields);
                
                // 显示结果弹窗
                this.showParsedMappingsModal(mappings, requestData, formFields);
                
            } catch (error) {
                console.error('AI解析失败:', error);
                // AI失败时,降级到手动模式
                if (confirm(`❌ AI解析失败: ${error.message}\n\n是否切换到手动模式?`)) {
                    this.showManualMappingModal(requestData);
                }
            }
        },
        
        // 显示手动映射模式(不用AI)
        showManualMappingModal(requestData) {
            const formFields = this.extractFormFields();
            
            if (formFields.length === 0) {
                alert('❗ 未找到表单字段');
                return;
            }
            
            // 创建空映射
            const mappings = [];
            
            // 直接显示编辑弹窗
            this.showParsedMappingsModal(mappings, requestData, formFields);
        },
        
        // 调用AI进行解析
        async callAIForParsing(requestData, formFields) {
            // 默认配置(硬编码)
            const DEFAULT_CONFIG = {
                cozeBotId: '7588782023028965426',
                cozeApiToken: 'pat_JmRZ99SO7iSeWYKnm0h4QB8EWgQg52dd6skEsocKdPbnCNCnljbmbxsSIKgTO839'
            };
            
            // 尝试从localStorage读取,如果没有则使用默认配置
            const storedConfig = JSON.parse(localStorage.getItem('api-viewer-ai-config') || '{}');
            const aiConfig = {
                cozeBotId: storedConfig.cozeBotId || DEFAULT_CONFIG.cozeBotId,
                cozeApiToken: storedConfig.cozeApiToken || DEFAULT_CONFIG.cozeApiToken
            };
            
            console.log('🔧 使用AI配置:', {
                botId: aiConfig.cozeBotId,
                tokenPrefix: aiConfig.cozeApiToken.substring(0, 20) + '...'
            });
            
            const labels = formFields.map(f => f.label);
            const userMessage = `请帮我匹配以下数据:

表单字段: ${JSON.stringify(labels)}
请求参数: ${JSON.stringify(requestData)}

请返回JSON格式的匹配结果`;
            
            // 创建对话
            const chatResponse = await fetch('https://api.coze.cn/v3/chat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${aiConfig.cozeApiToken}`
                },
                body: JSON.stringify({
                    bot_id: aiConfig.cozeBotId,
                    user_id: 'api-viewer-user',
                    stream: false,
                    additional_messages: [{
                        role: 'user',
                        content: userMessage,
                        content_type: 'text'
                    }]
                })
            });
            
            if (!chatResponse.ok) {
                throw new Error(`API请求失败: ${chatResponse.status}`);
            }
            
            const chatData = await chatResponse.json();
            
            console.log('Coze Chat完整响应:', chatData);
            
            if (chatData.code !== 0) {
                throw new Error(`AI错误: ${chatData.msg}`);
            }
            
            // 等待对话完成并获取消息
            let content = '';
            
            if (chatData.data.status === 'completed') {
                // 直接获取结果
                content = chatData.data.msg || chatData.data.content || '';
                console.log('直接获取的content:', content);
            } else if (chatData.data.status === 'in_progress') {
                // 需要轮询等待
                console.log('对话处理中,开始轮询...');
                content = await this.waitForChatCompletion(chatData.data.id, chatData.data.conversation_id, aiConfig);
            } else {
                throw new Error(`未知状态: ${chatData.data.status}`);
            }
            
            if (!content || content.trim() === '') {
                throw new Error('AI返回内容为空');
            }
            
            console.log('最终获取的content:', content);
            
            // 解析响应
            let result;
            
            try {
                // 尝试提取JSON
                const jsonMatch = content.match(/```json\s*([\s\S]*?)```/) || content.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const jsonStr = jsonMatch[1] || jsonMatch[0];
                    result = JSON.parse(jsonStr);
                } else {
                    result = JSON.parse(content);
                }
            } catch (error) {
                console.error('解析AI响应失败:', error, '原始内容:', content);
                throw new Error('无法解析AI返回的结果');
            }
            
            // 转换为内部格式
            const mappings = [];
            
            console.log('=== 开始解析AI返回的结果 ===');
            console.log('AI返回的result:', result);
            console.log('表单字段formFields:', formFields.map(f => f.label));
            
            formFields.forEach(field => {
                const matchData = result[field.label];
                console.log(`匹配 ${field.label}:`, matchData);
                
                if (matchData && matchData.name) {
                    // 注意: value可以为null,也要添加
                    mappings.push({
                        formLabel: field.label,
                        requestField: matchData.name,
                        value: matchData.value !== null && matchData.value !== undefined ? matchData.value : '',
                        element: field.element
                    });
                    console.log(`✅ 添加匹配: ${field.label} -> ${matchData.name} = ${matchData.value}`);
                } else {
                    console.log(`❌ 未匹配: ${field.label}`);
                }
            });
            
            console.log('=== 最终mappings ===');
            console.log(mappings);
            
            return mappings;
        },
        
        // 等待对话完成
        async waitForChatCompletion(chatId, conversationId, aiConfig) {
            let retries = 0;
            const maxRetries = 60; // 60次 * 5秒 = 300秒 (5分钟)
            
            while (retries < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, 5000)); // 等待5秒
                retries++;
                
                console.log(`📡 轮询第${retries}次 (每5秒一次,最多5分钟)...`);
                
                const statusResponse = await fetch(`https://api.coze.cn/v3/chat/retrieve?chat_id=${chatId}&conversation_id=${conversationId}`, {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${aiConfig.cozeApiToken}`
                    }
                });
                
                if (!statusResponse.ok) {
                    console.error('查询状态失败:', statusResponse.status);
                    continue;
                }
                
                const statusData = await statusResponse.json();
                console.log(`状态:`, statusData.data?.status);
                
                if (statusData.data.status === 'completed') {
                    console.log('✅ 对话完成!正在获取消息...');
                    
                    // 获取消息列表
                    const messagesResponse = await fetch(`https://api.coze.cn/v3/chat/message/list?chat_id=${chatId}&conversation_id=${conversationId}`, {
                        method: 'GET',
                        headers: {
                            'Authorization': `Bearer ${aiConfig.cozeApiToken}`
                        }
                    });
                    
                    if (!messagesResponse.ok) {
                        throw new Error(`获取消息失败: ${messagesResponse.status}`);
                    }
                    
                    const messagesData = await messagesResponse.json();
                    console.log('消息列表:', messagesData);
                    
                    // 找到Bot的回复
                    const botMessage = messagesData.data.find(msg => msg.role === 'assistant' && msg.type === 'answer');
                    
                    if (!botMessage) {
                        throw new Error('未找到Bot回复');
                    }
                    
                    console.log('Bot回复内容:', botMessage.content);
                    return botMessage.content;
                } else if (statusData.data.status === 'failed') {
                    throw new Error('对话失败: ' + statusData.data.last_error?.msg);
                }
            }
            
            throw new Error('等待超时(5分钟),Bot响应时间过长,请检查Bot配置或重试');
        },
        
        // 显示解析结果弹窗
        showParsedMappingsModal(mappings, requestData, formFields) {
            const existing = document.getElementById('ai-parse-modal');
            if (existing) existing.remove();
            
            // 获取所有未匹配的表单字段
            const matchedLabels = new Set(mappings.map(m => m.formLabel));
            const unmatchedFields = formFields.filter(f => !matchedLabels.has(f.label));
            
            console.log('已匹配字段:', mappings.map(m => m.formLabel));
            console.log('未匹配字段:', unmatchedFields.map(f => f.label));
            
            const modal = document.createElement('div');
            modal.id = 'ai-parse-modal';
            modal.style.cssText = `
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                width: 600px;
                max-height: 80vh;
                background: white;
                border: 1px solid #e0e0e0;
                border-radius: 8px;
                box-shadow: 0 4px 20px rgba(0,0,0,0.15);
                z-index: 10000000;
                display: flex;
                flex-direction: column;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            `;
            
            // 已匹配的字段
            const mappingsHTML = mappings.map((m, index) => `
                <div style="padding: 12px; border-bottom: 1px solid #f0f0f0; display: flex; align-items: center; gap: 10px;">
                    <div style="flex: 1;">
                        <div style="font-size: 12px; color: #666; margin-bottom: 4px;">表单字段:</div>
                        <input type="text" value="${this.escapeHtml(m.formLabel)}" readonly
                            style="width: 100%; padding: 6px; border: 1px solid #ddd; border-radius: 3px; font-size: 12px; background: #f5f5f5;">
                    </div>
                    <div style="padding-top: 20px; color: #999;">→</div>
                    <div style="flex: 1;">
                        <div style="font-size: 12px; color: #666; margin-bottom: 4px;">请求字段:</div>
                        <input type="text" id="mapping-field-${index}" value="${m.requestField}" list="request-fields-list"
                            style="width: 100%; padding: 6px; border: 1px solid #ddd; border-radius: 3px; font-size: 12px;">
                    </div>
                    <div style="flex: 1;">
                        <div style="font-size: 12px; color: #666; margin-bottom: 4px;">值:</div>
                        <input type="text" id="mapping-value-${index}" value="${this.escapeHtml(String(m.value))}" 
                            style="width: 100%; padding: 6px; border: 1px solid #ddd; border-radius: 3px; font-size: 12px;">
                    </div>
                </div>
            `).join('');
            
            // 生成datalist供输入框自动完成
            const datalistHTML = `
                <datalist id="request-fields-list">
                    ${Object.keys(requestData).map(key => `<option value="${key}">`).join('')}
                </datalist>
            `;
            
            // 未匹配的字段(允许手动填写)
            const unmatchedHTML = unmatchedFields.length > 0 ? `
                <div style="padding: 12px 15px; background: #f5f5f5; border-bottom: 1px solid #e0e0e0;">
                    <div style="font-weight: 500; font-size: 13px; color: #666; margin-bottom: 8px;">❓ 未匹配字段 (可手动补充)</div>
                </div>
                ${unmatchedFields.map((field, index) => {
                    const unmatchedIndex = mappings.length + index;
                    return `
                    <div style="padding: 12px; border-bottom: 1px solid #f0f0f0; display: flex; align-items: center; gap: 10px; background: #fafafa;">
                        <div style="flex: 1;">
                            <div style="font-size: 12px; color: #666; margin-bottom: 4px;">表单字段:</div>
                            <input type="text" value="${this.escapeHtml(field.label)}" readonly
                                style="width: 100%; padding: 6px; border: 1px solid #ddd; border-radius: 3px; font-size: 12px; background: #fff;">
                        </div>
                        <div style="padding-top: 20px; color: #ccc;">→</div>
                        <div style="flex: 1;">
                            <div style="font-size: 12px; color: #666; margin-bottom: 4px;">请求字段:</div>
                            <input type="text" id="mapping-field-${unmatchedIndex}" placeholder="输入字段名" list="request-fields-list"
                                style="width: 100%; padding: 6px; border: 1px solid #ddd; border-radius: 3px; font-size: 12px;">
                        </div>
                        <div style="flex: 1;">
                            <div style="font-size: 12px; color: #666; margin-bottom: 4px;">值:</div>
                            <input type="text" id="mapping-value-${unmatchedIndex}" value="" placeholder="手动填写"
                                style="width: 100%; padding: 6px; border: 1px solid #ddd; border-radius: 3px; font-size: 12px;">
                        </div>
                    </div>
                `;
                }).join('')}
            ` : '';
            
            modal.innerHTML = `
                <div style="padding: 15px 20px; border-bottom: 1px solid #e0e0e0; display: flex; justify-content: space-between; align-items: center;">
                    <div style="font-weight: 600; font-size: 15px;">🤖 AI解析结果</div>
                    <button onclick="document.getElementById('ai-parse-modal').remove()" 
                        style="padding: 4px 10px; background: white; color: #666; border: 1px solid #ddd; border-radius: 3px; cursor: pointer; font-size: 12px;">
                        ✕
                    </button>
                </div>
                <div style="padding: 15px; background: #fffbe6; border-bottom: 1px solid #ffe58f; font-size: 12px; color: #666;">
                    💡 提示: AI已匹配 ${mappings.length} 个字段,未匙配 ${unmatchedFields.length} 个字段可手动补充 (请求字段可手动输入或选择)
                </div>
                <div style="flex: 1; overflow-y: auto;">
                    ${mappingsHTML}
                    ${unmatchedHTML}
                </div>
                ${datalistHTML}
                <div style="padding: 15px 20px; border-top: 1px solid #e0e0e0; display: flex; justify-content: space-between; gap: 10px;">
                    <input type="text" id="template-name" placeholder="模板名称 (选填)" 
                        style="flex: 1; padding: 8px 12px; border: 1px solid #ddd; border-radius: 3px; font-size: 12px;">
                    <button onclick="window.APIViewerInstance.saveAndApplyTemplate(${mappings.length + unmatchedFields.length}, ${this.escapeJson(requestData)}, ${this.escapeJson(formFields.map(f => f.label))})" 
                        style="padding: 8px 16px; background: #52c41a; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 13px; font-weight: 500;">
                        保存到模板集
                    </button>
                    <button onclick="window.APIViewerInstance.applyCurrentMappings(${mappings.length + unmatchedFields.length}, ${this.escapeJson(formFields.map(f => f.label))})" 
                        style="padding: 8px 16px; background: #1890ff; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 13px; font-weight: 500;">
                        直接回填
                    </button>
                </div>
            `;
            
            document.body.appendChild(modal);
            
            // 保存当前mappings和未匹配字段供后续使用
            this._currentMappings = mappings;
            this._currentUnmatchedFields = unmatchedFields;
            this._currentFormFields = formFields;
        },
        
        // 直接回填当前映射
        applyCurrentMappings(totalCount, allLabels) {
            const mappings = this._currentMappings || [];
            const formFields = this._currentFormFields || [];
            
            let successCount = 0;
            let failCount = 0;
            
            // 遍历所有字段(包括已匹配和未匹配的)
            for (let i = 0; i < totalCount; i++) {
                const fieldSelect = document.getElementById(`mapping-field-${i}`);
                const valueInput = document.getElementById(`mapping-value-${i}`);
                
                if (!fieldSelect || !valueInput) continue;
                
                const selectedField = fieldSelect.value;
                const value = valueInput.value;
                
                // 跳过未选择字段的
                if (!selectedField || selectedField === '') continue;
                
                // 找到对应的表单字段
                let formLabel;
                if (i < mappings.length) {
                    // 已匹配的字段
                    formLabel = mappings[i].formLabel;
                } else {
                    // 未匹配的字段,从DOM读取
                    const labelInput = fieldSelect.parentElement.previousElementSibling.previousElementSibling.querySelector('input');
                    formLabel = labelInput ? labelInput.value : null;
                }
                
                if (!formLabel) continue;
                
                // 找到对应的DOM元素
                const field = formFields.find(f => f.label === formLabel);
                
                if (!field) {
                    console.warn(`未找到表单字段: ${formLabel}`);
                    failCount++;
                    continue;
                }
                
                try {
                    const element = field.element;
                    if (element && element instanceof HTMLElement) {
                        element.value = value;
                        element.dispatchEvent(new Event('input', { bubbles: true }));
                        element.dispatchEvent(new Event('change', { bubbles: true }));
                        successCount++;
                    }
                } catch (error) {
                    console.error('填充失败:', error);
                    failCount++;
                }
            }
            
            const modal = document.getElementById('ai-parse-modal');
            if (modal) modal.remove();
        },
        
        // 保存并应用模板
        saveAndApplyTemplate(totalCount, requestData, allLabels) {
            const mappings = [];
            
            // 收集所有的映射关系(包括已匹配和手动补充的)
            for (let i = 0; i < totalCount; i++) {
                const fieldSelect = document.getElementById(`mapping-field-${i}`);
                const valueInput = document.getElementById(`mapping-value-${i}`);
                
                if (!fieldSelect || !valueInput) continue;
                
                const selectedField = fieldSelect.value;
                const value = valueInput.value;
                
                // 跳过未选择的字段
                if (!selectedField || selectedField === '') continue;
                
                // 获取表单字段名称
                const labelInput = fieldSelect.parentElement.previousElementSibling.previousElementSibling.querySelector('input');
                const formLabel = labelInput ? labelInput.value : null;
                
                if (!formLabel) continue;
                
                mappings.push({
                    formLabel: formLabel,
                    requestField: selectedField,
                    value: value
                });
            }
            
            if (mappings.length === 0) {
                alert('❗ 请至少匹配一个字段');
                return;
            }
            
            // 生成模板名称
            const nameInput = document.getElementById('template-name');
            const templateName = nameInput && nameInput.value.trim() 
                ? nameInput.value.trim()
                : `模板_${new Date().toLocaleString('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'})}`;
            
            // 保存模板
            const template = {
                name: templateName,
                mappings: mappings,
                createdAt: Date.now()
            };
            
            this.saveTemplate(template);
            
            const modal = document.getElementById('ai-parse-modal');
            if (modal) modal.remove();
        },
        
        destroy() {
            const panel = document.getElementById('api-viewer-panel');
            if (panel) panel.remove();
            
            const icon = document.getElementById('api-viewer-float-icon');
            if (icon) icon.remove();
            
            this.pinnedPanels.forEach(p => p.remove());
            this.pinnedPanels.clear();
            
            const allPinnedPanels = document.querySelectorAll('.pinned-api-panel');
            allPinnedPanels.forEach(p => p.remove());
        }
    };
    
    APIViewer.init();
    window.APIViewerInstance = APIViewer;
    
    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        
        if (event.data.type === 'API_VIEWER_CONFIG') {
            if (event.data.clearClosed) {
                localStorage.removeItem('api-viewer-closed');
            }
            APIViewer.updateConfig(event.data.config);
        } else if (event.data.type === 'API_VIEWER_AI_CONFIG') {
            // 接收AI配置并存入localStorage
            console.log('接收到AI配置:', event.data.aiConfig);
            localStorage.setItem('api-viewer-ai-config', JSON.stringify(event.data.aiConfig));
        } else if (event.data.type === 'API_VIEWER_DESTROY') {
            APIViewer.destroy();
            delete window.APIViewerInstance;
        }
    });
})();
