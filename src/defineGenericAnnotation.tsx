import { SAMPLE_PDF_URL, SAMPLE_EPUB_URL } from './constants';
import { OfflineIframe } from 'react-offline-iframe';
import React, { useEffect } from 'react';
import { SpecificAnnotationProps } from 'types';
import { b64_to_utf8, utf8_to_b64, wait } from 'utils';
import { deleteAnnotation, loadAnnotations, writeAnnotation } from 'annotationFileUtils';
import { Annotation } from './types';
import AnnotatorPlugin from 'main';
import { checkPseudoAnnotationEquality, getAnnotationHighlightTextData } from 'annotationUtils';
import { MarkdownRenderer, normalizePath, TFile } from 'obsidian';
import hypothesisFolder from 'hypothesisFolder';
import { DarkReaderType } from 'darkreader';

const proxiedHosts = new Set(['cdn.hypothes.is', 'via.hypothes.is', 'hypothes.is']);
export default ({ vault, plugin, resourceUrls }) => {
    const urlToPathMap = new Map();
    const GenericAnnotation = (
        props: SpecificAnnotationProps & {
            baseSrc: string;
            onIframePatch?: (iframe: HTMLIFrameElement) => Promise<void>;
        }
    ) => {
        function proxy(url: URL | string): URL {
            const href = typeof url == 'string' ? url : url.href;
            if (
                href == SAMPLE_PDF_URL ||
                ('pdf' in props && props.pdf == href) ||
                ((href.startsWith(`https://via.hypothes.is/proxy/static/xP1ZVAo-CVhW7kwNneW_oQ/1628964000/`) ||
                    href.startsWith(`https://via.hypothes.is/proxy/static/UsvswpbIZv6ZUQTERtj1CA/1641646800/`) ||
                    href.startsWith(`https://via.hypothes.is/proxy/static/VpXumaaWJSJVxmHv4EqN2g/1641916800/`)) &&
                    !href.endsWith('.html'))
            ) {
                let path;
                if (!('pdf' in props)) {
                    console.warn('Missing prop "pdf"');
                    return;
                }
                try {
                    path = new URL(props.pdf).href;
                } catch {
                    path = `vault:/${props.pdf}`;
                }
                return new URL(path);
            }
            if (href == SAMPLE_EPUB_URL || ('epub' in props && props.epub == href)) {
                let path;
                if (!('epub' in props)) {
                    console.warn('Missing prop "epub"');
                    return;
                }
                try {
                    path = new URL(props.epub).href;
                } catch {
                    path = `vault:/${props.epub}`;
                }
                return new URL(path);
            }
            if (href == `https://hypothes.is/api/`) {
                return new URL(`zip:/fake-service/api.json`);
            }
            if (href == `http://localhost:8001/api/links`) {
                return new URL(`zip:/fake-service/api/links.json`);
            }
            if (href == `http://localhost:8001/api/profile`) {
                return new URL(`zip:/fake-service/api/profile.json`);
            }
            if (href.startsWith(`http://localhost:8001/api/profile/groups`)) {
                return new URL(`zip:/fake-service/api/profile/groups.json`);
            }
            if (href.startsWith(`http://localhost:8001/api/groups`)) {
                return new URL(`zip:/fake-service/api/groups.json`);
            }
            if (typeof url == 'string') {
                return new URL(url);
            }
            switch (url.hostname) {
                case 'via.hypothes.is':
                    return new URL(`zip:/via.hypothes.is${url.pathname}`);
                case 'hypothes.is':
                    return new URL(`zip:/hypothes.is${url.pathname}`);
                case 'cdn.hypothes.is':
                    return new URL(`zip:/cdn.hypothes.is${url.pathname}`);
                // Remove hypothes.is trackers
                case 'js-agent.newrelic.com':
                case 'bam-cell.nr-data.net':
                    return new URL('zip:/ignore');
                default:
                    return url;
            }
        }

        async function readFromVaultPath(path) {
            const abstractFile = getAbstractFileByPath(path);
            return await readAbstractFile(abstractFile);
        }

        async function readAbstractFile(abstractFile) {
            return await vault.readBinary(abstractFile);
        }

        function getAbstractFileByPath(path) {
            let p;
            if (
                (p = vault.getAbstractFileByPath(path)) instanceof TFile ||
                (p = vault.getAbstractFileByPath(`${path}.html`)) instanceof TFile
            ) {
                return p;
            }
        }

        function getVaultPathResourceUrl(vaultPath) {
            function tryGetResourceUrl(vaultPath) {
                const abstractFile = getAbstractFileByPath(vaultPath);
                const resourcePath = vault.getResourcePath(abstractFile);
                urlToPathMap.set(resourcePath, vaultPath);
                return resourcePath;
            }
            try {
                return tryGetResourceUrl(vaultPath);
            } catch (e) {
                try {
                    return tryGetResourceUrl(decodeURI(vaultPath));
                } catch (e) {
                    return `error:/${encodeURIComponent(e.toString())}/`;
                }
            }
        }

        const darkReaderReferences: Set<WeakRef<DarkReaderType>> = new Set();

        const subFrames = new Set<WeakRef<Window>>();
        const forwardedMessages = new WeakSet();
        useEffect(() => {
            // Hypothesis expects the top window to be the hypothesis window.
            // This forwards any message posted to the top window to the children.
            const listener = async event => {
                if (forwardedMessages.has(event)) return;
                plugin.log('Top Window got message', { event, ...event.data });
                const forwarded = new Set();
                const forwardToSubFrames = () => {
                    const currentSubFrames = new Set([...subFrames].map(x => x.deref()).filter(x => x));
                    if (currentSubFrames.has(event.source as Window) && event.source != window) {
                        plugin.log('forwarding...');
                        for (const subFrame of currentSubFrames) {
                            if (forwarded.has(subFrame)) continue;
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            const newMessage = new (event.constructor as any)(event.type, event);
                            forwardedMessages.add(newMessage);
                            subFrame.dispatchEvent(newMessage);
                            forwarded.add(subFrame);
                        }
                    }
                };
                forwardToSubFrames();
            };
            addEventListener('message', listener);
            return () => removeEventListener('message', listener);
        });

        return (
            <OfflineIframe
                address={props.baseSrc}
                getUrl={url => {
                    const proxiedUrl = proxy(url);
                    if (proxiedUrl.protocol == 'vault:') {
                        return getVaultPathResourceUrl(normalizePath(proxiedUrl.pathname));
                    }
                    if (proxiedUrl.protocol == 'zip:') {
                        const pathName = normalizePath(proxiedUrl.pathname);
                        const res = resourceUrls.get(pathName) || resourceUrls.get(`${pathName}.html`);
                        if (res) return res;
                        console.error('file not found', { url });
                        debugger;
                    }
                    return proxiedUrl.toString();
                }}
                fetch={async (requestInfo: RequestInfo, requestInit?: RequestInit) => {
                    const href = typeof requestInfo == 'string' ? requestInfo : requestInfo.url;
                    const url = new URL(href);
                    let res = null;
                    if (href == `junk:/ignore`) {
                        return new Response(JSON.stringify({}, null, 2), {
                            status: 200,
                            statusText: 'ok'
                        });
                    }
                    if (href.startsWith(`http://localhost:8001/api/search`)) {
                        try {
                            res = await loadAnnotations(new URL(href), vault, props.annotationFile);
                        } catch (e) {
                            console.error('failed to load annotations', { error: e });
                        }
                    }
                    if (href.startsWith(`http://localhost:8001/api/annotations`)) {
                        if (requestInit.method == 'DELETE') {
                            res = await deleteAnnotation(
                                href.substr(`http://localhost:8001/api/annotations/`.length),
                                vault,
                                props.annotationFile
                            );
                        } else {
                            res = await writeAnnotation(
                                JSON.parse(requestInit.body.toString()),
                                plugin,
                                props.annotationFile
                            );
                        }
                    }
                    let buf;
                    if (url.protocol == 'vault:') {
                        try {
                            try {
                                buf = await readFromVaultPath(normalizePath(url.pathname));
                            } catch (e) {
                                buf = await readFromVaultPath(normalizePath(decodeURI(url.pathname)));
                            }
                            return new Response(buf, {
                                status: 200,
                                statusText: 'ok'
                            });
                        } catch (e) {
                            console.warn('mockFetch Failed, Error', { e, url });
                            return new Response(null, { status: 404, statusText: 'file not found' });
                        }
                    }
                    if (url.protocol == 'app:') {
                        try {
                            const vaultPath = urlToPathMap.get(
                                url.protocol + '//' + url.host + url.pathname + url.search
                            );
                            buf = await readFromVaultPath(vaultPath);
                            return new Response(buf, {
                                status: 200,
                                statusText: 'ok'
                            });
                        } catch (e) {
                            console.warn('mockFetch Failed, Error', { e });
                            return new Response(null, { status: 404, statusText: 'file not found' });
                        }
                    }
                    if (url.protocol == 'file:') {
                        try {
                            buf = await new Promise(res => {
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                (window as any).app.vault.adapter.fs.readFile(
                                    (x => (x.contains(':/') ? x.substr(1) : x))(
                                        decodeURI(url.pathname).replaceAll('\\', '/')
                                    ),
                                    (_, buf) => {
                                        res(buf);
                                    }
                                );
                            });

                            return new Response(buf, {
                                status: 200,
                                statusText: 'ok'
                            });
                        } catch (e) {
                            console.warn('mockFetch Failed, Error', { e });
                            return new Response(null, { status: 404, statusText: 'file not found' });
                        }
                    }
                    if (res) {
                        return new Response(JSON.stringify(res, null, 2), {
                            status: 200,
                            statusText: 'ok'
                        });
                    }
                    const folder = await hypothesisFolder;
                    if (proxiedHosts.has(url.host)) {
                        try {
                            const pathName = `${url.host}${url.pathname}`.replace(/^\//, '');
                            const file =
                                folder.file(pathName) ||
                                folder.file(`${pathName}.html`) ||
                                folder.file(`${pathName}.json`) ||
                                folder.file(`${decodeURI(pathName)}`) ||
                                folder.file(`${decodeURI(pathName)}.html`) ||
                                folder.file(`${decodeURI(pathName)}.json`);
                            const buf = await file.async('arraybuffer');
                            return new Response(buf, {
                                status: 200,
                                statusText: 'ok'
                            });
                        } catch (e) {
                            console.warn('mockFetch Failed, Error', { e, url });
                            return new Response(null, { status: 404, statusText: 'file not found' });
                        }
                    }
                    return await fetch(requestInfo, requestInit);
                }}
                htmlPostProcessFunction={(html: string) => {
                    if ('pdf' in props) {
                        html = html.replaceAll(SAMPLE_PDF_URL, proxy(props.pdf).href);
                    }
                    if ('epub' in props) {
                        html = html.replaceAll(SAMPLE_EPUB_URL, proxy(props.epub).href);
                    }
                    return html;
                }}
                onIframePatch={async iframe => {
                    subFrames.add(new WeakRef(iframe.contentWindow));
                    patchSidebarMarkdownRendering(iframe, props.annotationFile, plugin);
                    patchIframeEventBubbling(iframe, props.containerEl);
                    await props.onIframePatch?.(iframe);
                    iframe.contentWindow.addEventListener('message', async msg => {
                        if (forwardedMessages.has(msg)) return;
                        plugin.log('On Message Called', { iframe, msg, ...msg.data });
                        const forwarded = new Set();
                        const forwardToSubFrames = () => {
                            const currentSubFrames = new Set([...subFrames].map(x => x.deref()).filter(x => x));
                            plugin.log('forwarding...');
                            for (const subFrame of currentSubFrames) {
                                if (forwarded.has(subFrame)) continue;
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                const newMessage = new (msg.constructor as any)(msg.type, msg);
                                forwardedMessages.add(newMessage);
                                subFrame.dispatchEvent(newMessage);
                                forwarded.add(subFrame);
                            }
                        };
                        forwardToSubFrames();
                    });

                    /* eslint-disable @typescript-eslint/no-explicit-any */
                    (iframe.contentWindow as any).DarkReader = (
                        await (iframe.contentWindow as any).eval(
                            `import(\`${resourceUrls.get('dark-reader/darkreader.js')}\`)`
                        )
                    ).default;
                    darkReaderReferences.add(new WeakRef((iframe.contentWindow as any).DarkReader));
                    const garbageCollectedDarkReaders = [...darkReaderReferences].filter(r => !r.deref());
                    garbageCollectedDarkReaders.forEach(r => darkReaderReferences.delete(r));
                    (iframe.contentWindow as any).DarkReader.setFetchMethod(iframe.contentWindow.fetch);
                    await props.onDarkReadersUpdated(darkReaderReferences);
                    /* eslint-enable @typescript-eslint/no-explicit-any */
                    iframe.contentDocument.documentElement.addEventListener('keydown', function (ev) {
                        if (ev.key == 'Shift') {
                            for (const highlightElem of iframe.contentDocument.documentElement.getElementsByTagName(
                                'HYPOTHESIS-HIGHLIGHT'
                            ) as HTMLCollectionOf<HTMLElement>) {
                                highlightElem.draggable = true;
                            }
                        }
                    });
                    iframe.contentDocument.documentElement.addEventListener('keyup', function (ev) {
                        if (ev.key == 'Shift') {
                            for (const highlightElem of iframe.contentDocument.documentElement.getElementsByTagName(
                                'HYPOTHESIS-HIGHLIGHT'
                            ) as HTMLCollectionOf<HTMLElement>) {
                                highlightElem.draggable = false;
                            }
                        }
                    });
                    iframe.contentDocument.documentElement.addEventListener('mousemove', function (ev) {
                        const elem = ev.target as HTMLElement;
                        if (elem.tagName != 'HYPOTHESIS-HIGHLIGHT') {
                            return;
                        }
                        elem.draggable = false;
                        if (ev.shiftKey) {
                            elem.draggable = true;
                        }

                        elem.onkeydown = ev => {
                            elem.draggable = ev.key == 'Shift' || ev.shiftKey;
                        };
                        elem.onkeyup = ev => {
                            elem.draggable &&= ev.key != 'Shift';
                        };

                        elem.ondragstart = async event => {
                            event.dataTransfer.setData('text/plain', 'drag-event::hypothesis-highlight');
                            const pseudoAnnotation = (elem as HTMLElement & { _annotation: Annotation })._annotation;
                            const annotations = await loadAnnotations(null, vault, props.annotationFile);
                            const matchingAnnotations = annotations.rows.filter(annotation =>
                                checkPseudoAnnotationEquality(annotation, pseudoAnnotation)
                            );
                            if (matchingAnnotations.length > 0) {
                                const annotation = matchingAnnotations[0];
                                const { exact } = getAnnotationHighlightTextData(annotation);
                                (plugin as AnnotatorPlugin).dragData = {
                                    annotationFilePath: props.annotationFile,
                                    annotationId: annotation.id,
                                    annotationText: exact
                                };
                            }
                        };
                    });
                }}
                webSocketSetup={createServer => {
                    const mockServer = createServer('wss://h-websocket.hypothes.is/ws');
                    mockServer.on('connection', () => '');
                    mockServer.on('message', () => {
                        mockServer.send(
                            JSON.stringify({ type: 'whoyouare', userid: 'Obsidian User', ok: true, reply_to: 1 })
                        );
                    });
                }}
                onload={async iframe => {
                    let sidebarFrame;
                    do {
                        await wait(100);
                        sidebarFrame =
                            iframe?.contentDocument
                                ?.querySelector('iframe')
                                ?.contentDocument?.querySelector('body > hypothesis-sidebar')
                                ?.shadowRoot?.querySelector('div > iframe') ||
                            iframe?.contentDocument
                                ?.querySelector('body > hypothesis-sidebar')
                                ?.shadowRoot?.querySelector('div > iframe');
                    } while (
                        sidebarFrame == null ||
                        !sidebarFrame?.contentDocument?.querySelector(
                            'body > hypothesis-app > div > div.TopBar > div > div.Menu > button > span > span.GroupList__menu-label'
                        )
                    );

                    const style = sidebarFrame.contentDocument.createElement('style');
                    style.textContent = `
        .PublishControlButton--primary {
            border-top-right-radius: 2px;
            border-bottom-right-radius: 2px;
        }

        .annotation-publish-button__menu-wrapper {
            display: none;
        }

        .AnnotationHeader__highlight {
            display: none!important;
        }
        
        .AnnotationShareInfo {
            display: none!important;
        }
        
        .AnnotationHeader__icon {
            display: none!important;
        }
        
        .TopBar__login-links {
            display: none!important;
        }
        
        body > hypothesis-app > div > div.TopBar > div > div.Menu {
            display: none!important;
        }
        
        body > hypothesis-app > div > div.TopBar > div > button {
            display: none!important;
        }`;
                    sidebarFrame.contentDocument.head.appendChild(style);

                    await props.onload(iframe);
                }}
                outerIframeProps={{ height: '100%', width: '100%' }}
            />
        );
    };
    return GenericAnnotation;
};

function patchSidebarMarkdownRendering(iframe: HTMLIFrameElement, filePath: string, plugin: AnnotatorPlugin) {
    type HTMLElementConstructor = typeof window.HTMLElement;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const IframeElement = (iframe.contentWindow as any).Element;
    const existingKeys = new Set([...Object.getOwnPropertyNames(IframeElement.prototype)]);
    for (const key in Element.prototype) {
        try {
            if (!existingKeys.has(key)) {
                IframeElement.prototype[key] = Element.prototype[key];
            }
        } catch (e) {}
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    class ObsidianMarkdown extends ((iframe.contentWindow as any).HTMLElement as HTMLElementConstructor) {
        markdown: string;

        // Whenever an attibute is changed, this function is called. A switch statement is a good way to handle the various attributes.
        // Note that this also gets called the first time the attribute is set, so we do not need any special initialisation code.
        attributeChangedCallback(name, oldValue, newValue) {
            if (name == 'markdownbase64') {
                this.markdown = b64_to_utf8(newValue);
                (async () => {
                    MarkdownRenderer.renderMarkdown(this.markdown, this, filePath, null);
                    const maxDepth = 10;
                    const patchEmbeds = (el: HTMLElement, filePath: string, depth: number) => {
                        if (depth > maxDepth) return;
                        [...el.findAll('.internal-embed')].forEach(async (el: HTMLElement) => {
                            const src = el.getAttribute('src');
                            const target =
                                typeof src === 'string' && plugin.app.metadataCache.getFirstLinkpathDest(src, filePath);
                            if (target instanceof TFile) {
                                el.innerText = '';
                                switch (target.extension) {
                                    case 'md':
                                        el.innerHTML = `<div class="markdown-embed"><div class="markdown-embed-title">${target.basename}</div><div class="markdown-embed-content node-insert-event markdown-embed-page"><div class="markdown-preview-view"></div></div><div class="markdown-embed-link" aria-label="Open link"><svg viewBox="0 0 100 100" class="link" width="20" height="20"><path fill="currentColor" stroke="currentColor" d="M74,8c-4.8,0-9.3,1.9-12.7,5.3l-10,10c-2.9,2.9-4.7,6.6-5.1,10.6C46,34.6,46,35.3,46,36c0,2.7,0.6,5.4,1.8,7.8l3.1-3.1 C50.3,39.2,50,37.6,50,36c0-3.7,1.5-7.3,4.1-9.9l10-10c2.6-2.6,6.2-4.1,9.9-4.1s7.3,1.5,9.9,4.1c2.6,2.6,4.1,6.2,4.1,9.9 s-1.5,7.3-4.1,9.9l-10,10C71.3,48.5,67.7,50,64,50c-1.6,0-3.2-0.3-4.7-0.8l-3.1,3.1c2.4,1.1,5,1.8,7.8,1.8c4.8,0,9.3-1.9,12.7-5.3 l10-10C90.1,35.3,92,30.8,92,26s-1.9-9.3-5.3-12.7C83.3,9.9,78.8,8,74,8L74,8z M62,36c-0.5,0-1,0.2-1.4,0.6l-24,24 c-0.5,0.5-0.7,1.2-0.6,1.9c0.2,0.7,0.7,1.2,1.4,1.4c0.7,0.2,1.4,0,1.9-0.6l24-24c0.6-0.6,0.8-1.5,0.4-2.2C63.5,36.4,62.8,36,62,36 z M36,46c-4.8,0-9.3,1.9-12.7,5.3l-10,10c-3.1,3.1-5,7.2-5.2,11.6c0,0.4,0,0.8,0,1.2c0,4.8,1.9,9.3,5.3,12.7 C16.7,90.1,21.2,92,26,92s9.3-1.9,12.7-5.3l10-10C52.1,73.3,54,68.8,54,64c0-2.7-0.6-5.4-1.8-7.8l-3.1,3.1 c0.5,1.5,0.8,3.1,0.8,4.7c0,3.7-1.5,7.3-4.1,9.9l-10,10C33.3,86.5,29.7,88,26,88s-7.3-1.5-9.9-4.1S12,77.7,12,74 c0-3.7,1.5-7.3,4.1-9.9l10-10c2.6-2.6,6.2-4.1,9.9-4.1c1.6,0,3.2,0.3,4.7,0.8l3.1-3.1C41.4,46.6,38.7,46,36,46L36,46z"></path></svg></div></div>`;
                                        const previewEl = el.getElementsByClassName(
                                            'markdown-preview-view'
                                        )[0] as HTMLElement;
                                        MarkdownRenderer.renderMarkdown(
                                            await plugin.app.vault.cachedRead(target),
                                            previewEl,
                                            target.path,
                                            null
                                        );
                                        await patchEmbeds(previewEl, target.path, depth + 1);
                                        el.addClasses(['is-loaded']);
                                        break;
                                    default:
                                        el.createEl(
                                            'img',
                                            { attr: { src: plugin.app.vault.getResourcePath(target) } },
                                            img => {
                                                if (el.hasAttribute('width'))
                                                    img.setAttribute('width', el.getAttribute('width'));
                                                if (el.hasAttribute('alt'))
                                                    img.setAttribute('alt', el.getAttribute('alt'));
                                            }
                                        );
                                        el.addClasses(['image-embed', 'is-loaded']);
                                        break;
                                }
                            }
                        });
                    };
                    patchEmbeds(this, filePath, 1);
                })();
            }
        }

        // We need to specify which attributes will be watched for changes. If an attribute is not included here, attributeChangedCallback will never be called for it
        static get observedAttributes() {
            return ['markdownbase64'];
        }
    }

    // Now that our class is defined, we can register it
    iframe.contentWindow.customElements.define('obsidian-markdown', ObsidianMarkdown);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (iframe.contentWindow as any).renderObsidianMarkdown = markdown => {
        return `<obsidian-markdown markdownbase64="${utf8_to_b64(markdown)}" />`;
    };
}

function patchIframeEventBubbling(iframe: HTMLIFrameElement, container: HTMLElement) {
    const events = [];
    for (const property in container) {
        const match = property.match(/^on(.*)/);
        if (match) {
            events.push(match[1]);
        }
    }
    for (const event of events) {
        iframe.addEventListener(event, ev => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            container.dispatchEvent(new (ev.constructor as any)(ev.type, ev));
        });
    }
}
