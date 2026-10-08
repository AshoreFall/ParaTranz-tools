// ==UserScript==
// @name         ParaTranz-tools
// @namespace    local.paratranz.review-shortcut
// @version      1.5.1
// @description  检查与审核、空译文保存保留状态、注释 @ 补全、分页记忆，以及代码术语和格式标签的悬浮说明。
// @match        https://paratranz.cn/projects/*/strings*
// @grant        unsafeWindow
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/AshoreFall/ParaTranz-tools/main/dist/paratranz-review-shortcuts.meta.js
// @downloadURL  https://raw.githubusercontent.com/AshoreFall/ParaTranz-tools/main/dist/paratranz-review-shortcuts.user.js
// ==/UserScript==

(() => {
    'use strict';

    // 功能：检查/审核、空译文保存、保存菜单、注释 @ 补全、代码悬浮说明、分页修复与页码记忆。
    // 修改功能时，找到下面对应的中文注释即可。
    // ===== 运行状态 =====
    const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const doc = page.document;
    const ID = 'pz-direct-reviewed-shortcut';
    let mounted = null;
    let pending = false;
    let scheduled = false;
    const nativeChecks = new Map();
    let mainControl = null;

    // ===== 编辑器与权限 =====
    function editorVM() {
        const el = doc.querySelector('.string-editor');
        let vm = el?.__vue__;
        for (let count = 0; vm && count < 8; count++, vm = vm.$parent) {
            if (vm.$options?.name === 'stringEditor' && vm.item && vm.$req?.put) return vm;
        }
        return null;
    }

    function allowed(vm) {
        // 只检查当前项目的权限。
        const permission = Number(vm?.$store?.state?.permissions?.[vm.projectId]);
        return vm?.isManager === true && (permission === 3 || permission === 10);
    }

    function disabledReason(vm, requireSave = false) {
        if (pending || vm?.saving) return '正在保存，请稍候';
        if (!allowed(vm)) return '仅项目所有者和管理员可用';
        if (!Number.isSafeInteger(Number(vm.item?.id)) || Number(vm.item.id) <= 0) return '请先选择词条';
        if (Number(vm.item.stage) === 5) return '当前词条已经是已审核';
        if (Number(vm.item.stage) === 9) return '请先通过原生菜单解锁词条';
        if (Number(vm.item.stage) === -1) return '请先通过原生菜单取消隐藏';
        if (!vm.canEdit) return '当前词条不可编辑或由其他成员编辑中';
        if (requireSave && !vm.canSave) return '没有需要保存的译文修改';
        return '';
    }

    // ===== 提示信息与词条状态 =====
    function tell(vm, kind, message) {
        if (typeof vm?.$alert?.[kind] === 'function') vm.$alert[kind](message);
        else page.alert(message);
    }

    function stringResult(result, id) {
        // 兼容页面请求工具的两种返回格式。
        const item = result?.id != null ? result : result?.data;
        return Number(item?.id) === id && Number.isInteger(Number(item?.stage)) ? item : null;
    }

    function stageName(stage) {
        return ({ '-1': '已隐藏', 0: '未翻译', 1: '已翻译', 2: '有疑问',
            3: '已检查', 5: '已审核', 9: '已锁定' })[stage] || `状态 ${stage}`;
    }

    // ===== 功能：检查与直接审核的提交、服务器结果确认 =====
    async function setCurrentStage(targetStage, requireSave = false, preserveStage = false, sourceVM = null) {
        const vm = editorVM();
        if (sourceVM && sourceVM !== vm) return;
        const reason = preserveStage ? emptySaveReason(vm) : disabledReason(vm, requireSave);
        if (reason) {
            tell(vm, 'error', reason);
            return;
        }
        const id = Number(vm.item.id);
        const project = Number(vm.projectId);
        const translation = vm.translation;
        const stage = Number(vm.item.stage);
        const saveTranslation = Boolean(vm.canSave);
        const draftKey = vm.draftKey;
        const action = preserveStage ? '保存' : targetStage === 3 ? '检查' : '审核';
        pending = true;
        sync();
        let ownsSaving = false;
        try {
            // 使用网站原有的保存前检查。
            if (typeof vm.preSaveCheck !== 'function') throw new Error('页面编辑器版本不兼容，请更新脚本');
            // 允许空译文审核；和网站一样，只检查非空文本。
            if (translation && !await vm.preSaveCheck()) return;
            if (editorVM() !== vm || Number(vm.projectId) !== project || Number(vm.item.id) !== id ||
                Number(vm.item.stage) !== stage || vm.translation !== translation ||
                (preserveStage ? Boolean(emptySaveReason(vm, true)) : !allowed(vm)) || !vm.canEdit || vm.saving) {
                throw new Error('词条或译文已变化，请在当前词条重新操作');
            }
            vm.saving = true;
            ownsSaving = true;
            if (typeof vm.$req.get !== 'function') throw new Error('页面编辑器版本不兼容，请更新脚本');
            // 只提交当前词条，再读取服务器状态确认结果。
            const payload = { id, stage: targetStage };
            if (saveTranslation) payload.translation = translation;
            const itemPath = `/projects/${project}/strings/${id}`;
            let writeError = null;
            try {
                await vm.$req.put(`/projects/${project}/strings`, { op: 'edit', items: [payload] }, { silent: true });
            } catch (error) {
                // 响应丢失时也可能已保存成功，只读取结果，不重复提交。
                writeError = error;
            }
            let result;
            try {
                result = stringResult(await vm.$req.get(itemPath, { silent: true }), id);
            } catch (error) {
                const detail = writeError?.message || error?.message || '网络异常';
                throw new Error(`无法读取${action}结果（${detail}）。请重新打开原词条查看；脚本没有自动重试提交。`);
            }
            if (!result) throw new Error(`服务器返回的词条数据不完整，无法确认${action}结果。请重新打开原词条查看。`);
            const sameEditor = editorVM() === vm && Number(vm.projectId) === project && Number(vm.item?.id) === id;
            if (sameEditor) vm.item.stage = Number(result.stage);
            if (saveTranslation && result.translation !== translation) {
                throw new Error(`词条 ${id} 当前为“${stageName(Number(result.stage))}”，但服务器译文与本次提交不一致，请检查原词条。`);
            }
            if (Number(result.stage) !== targetStage) {
                const detail = writeError ? `（${writeError.message || '提交异常'}）` : '';
                throw new Error(`未完成${action}${detail}：词条 ${id} 的服务器状态是“${stageName(Number(result.stage))}”。`);
            }
            if (sameEditor && vm.translation === translation) {
                // 当前草稿和选中词条未变化时，才通知网站刷新列表。
                if (preserveStage && draftKey) vm.$ss?.remove?.(draftKey);
                vm.$emit('save', result);
                tell(vm, 'success', preserveStage ? `空译文已保存，状态保留为${stageName(targetStage)}（服务器已确认）` :
                    `词条已标记为${stageName(targetStage)}（服务器已确认）`);
            } else {
                tell(vm, 'success', preserveStage ? `原词条 ${id} 的空译文已保存，状态保留为${stageName(targetStage)}；当前编辑内容已保留。` :
                    `原词条 ${id} 已标记为${stageName(targetStage)}（服务器已确认）；当前编辑内容已保留。`);
            }
        } catch (error) {
            tell(vm, 'error', error?.message || '标记失败，请稍后重试');
        } finally {
            if (ownsSaving) vm.saving = false;
            pending = false;
            sync();
        }
    }

    // ===== 功能：在保存菜单中增加选项 =====
    function unmount() {
        mounted?.li.remove();
        mounted?.saveLi.remove();
        mounted = null;
        for (const [button, control] of nativeChecks) {
            button.removeEventListener('click', control.handler, true);
            if (button.textContent === '保存并检查') button.textContent = control.originalLabel;
        }
        nativeChecks.clear();
        restoreMainButton();
    }

    // ===== 功能：原生保存入口明确为“保存并检查”（笑脸） =====
    function nativeCheckButton(host) {
        for (const [button, control] of nativeChecks) {
            if (!button.isConnected || !host.contains(button)) {
                button.removeEventListener('click', control.handler, true);
                nativeChecks.delete(button);
            }
        }
        const button = [...host.querySelectorAll('.dropdown-item')].find(el =>
            el !== mounted?.saveButton && (nativeChecks.has(el) ||
                /^(保存并审核|Save and Review)$/.test(el.textContent.trim())));
        if (!button || typeof editorVM()?.markAs !== 'function') return null;
        if (!nativeChecks.has(button)) {
            const handler = event => {
                event.preventDefault();
                event.stopImmediatePropagation();
                const vm = editorVM();
                if (!button.isConnected || !allowed(vm) || !vm.canSave || !vm.canReview || vm.saving || pending) return;
                // 使用页面保存前检查，明确提交“已检查”，与下面的直接审核分开。
                setCurrentStage(3, true);
            };
            nativeChecks.set(button, { originalLabel: button.textContent, handler });
            button.addEventListener('click', handler, true);
        }
        if (button.textContent !== '保存并检查') button.textContent = '保存并检查';
        return button.closest('li');
    }

    // ===== 功能：蓝标显示浅绿色“检查”，笑脸显示绿色“审核” =====
    function mainLabel(button, text) {
        // 只改文字节点，保留网站按钮和图标上的绑定。
        for (const node of button.childNodes) {
            if (node.nodeType === 3 && /^(审核|Review|保存|Save|检查|Check)$/.test(node.nodeValue.trim())) {
                const next = ' ' + text + ' ';
                if (node.nodeValue !== next) node.nodeValue = next;
            }
        }
    }

    function restoreMainButton() {
        if (!mainControl) return;
        const control = mainControl;
        control.button.removeEventListener('click', control.handler, true);
        control.icon.remove();
        for (const [icon, display] of control.icons) icon.style.display = display;
        for (const [element, styles] of control.styles) {
            for (const [property, value, priority] of styles) {
                if (value) element.style.setProperty(property, value, priority);
                else element.style.removeProperty(property);
            }
        }
        if (control.button.isConnected) {
            const vm = control.vm;
            const nativeReview = vm.canReview && !vm.canSave;
            mainLabel(control.button, control.english ? (nativeReview ? 'Review' : 'Save') : (nativeReview ? '审核' : '保存'));
            control.button.disabled = Boolean(vm.saving || (!nativeReview && !vm.canSave));
            control.button.title = control.originalTitle;
        }
        mainControl = null;
    }

    function syncMainButton(vm, anchor) {
        const dropdown = anchor.closest('.b-dropdown');
        const button = [...(dropdown?.parentElement?.children || [])].find(el =>
            el.tagName === 'BUTTON' && el.classList.contains('btn'));
        const stage = Number(vm.item.stage);
        const target = stage === 3 ? 5 : stage > 0 && stage < 3 ? 3 : null;
        if (mainControl && (mainControl.button !== button || vm.canSave || !target || !vm.canEdit)) restoreMainButton();
        if (!button || vm.canSave || !target || !vm.canEdit) return;
        const toggle = dropdown.querySelector('button.dropdown-toggle');
        if (!mainControl) {
            const handler = event => {
                event.preventDefault();
                event.stopImmediatePropagation();
                const current = editorVM(), currentStage = Number(current?.item?.stage);
                if (current !== vm || current.canSave || pending || current.saving || !allowed(current)) return;
                if (currentStage === 3) setCurrentStage(5);
                else if (currentStage > 0 && currentStage < 3) setCurrentStage(3);
            };
            const icon = doc.createElement('span');
            icon.setAttribute('aria-hidden', 'true');
            icon.style.marginRight = '.35em';
            const styles = new Map();
            for (const element of [button, toggle].filter(Boolean)) {
                styles.set(element, ['background-color', 'border-color', 'color'].map(property =>
                    [property, element.style.getPropertyValue(property), element.style.getPropertyPriority(property)]));
            }
            mainControl = { button, handler, icon, icons: new Map(), styles, vm,
                originalTitle: button.title, english: /\b(Review|Save)\b/.test(button.textContent) };
            button.insertBefore(icon, button.firstChild);
            button.addEventListener('click', handler, true);
        }
        const text = target === 3 ? '检查' : '审核';
        const color = target === 3 ? '#20c997' : '#28a745';
        mainLabel(button, text);
        button.title = text;
        button.disabled = Boolean(disabledReason(vm));
        const symbol = target === 3 ? '☺' : '✓';
        if (mainControl.icon.textContent !== symbol) mainControl.icon.textContent = symbol;
        for (const icon of button.querySelectorAll('svg')) {
            if (!mainControl.icons.has(icon)) mainControl.icons.set(icon, icon.style.display);
            if (icon.style.display !== 'none') icon.style.display = 'none';
        }
        for (const element of mainControl.styles.keys()) {
            for (const [property, value] of [['background-color', color], ['border-color', color], ['color', '#fff']]) {
                if (element.style.getPropertyValue(property) !== value) element.style.setProperty(property, value, 'important');
            }
        }
    }

    function sync() {
        scheduled = false;
        syncPaging();
        syncEmptySaving();
        syncCodeHints();
        if (!/^\/projects\/\d+\/strings\/?$/.test(page.location.pathname)) {
            unmount();
            return;
        }
        const vm = editorVM();
        if (!allowed(vm)) {
            unmount();
            return;
        }
        const host = doc.querySelector('.string-editor');
        const hidden = [...host.querySelectorAll('.dropdown-item')].find(el =>
            /^(标记为已隐藏|Mark as Hidden)$/.test(el.textContent.trim()));
        const anchor = hidden?.closest('li');
        if (!anchor || !anchor.parentElement?.classList.contains('dropdown-menu')) {
            unmount();
            return;
        }
        if (mounted && (!mounted.anchor.isConnected || mounted.anchor !== anchor)) unmount();
        syncMainButton(vm, anchor);
        if (!mounted) {
            // 按网站原有的下拉菜单结构添加按钮。
            const li = doc.createElement('li');
            li.id = ID;
            li.setAttribute('role', 'presentation');
            const button = doc.createElement('button');
            button.type = 'button';
            button.className = 'dropdown-item';
            button.setAttribute('role', 'menuitem');
            button.textContent = '标记为已审核';
            button.addEventListener('click', () => setCurrentStage(5));
            li.appendChild(button);
            anchor.before(li);
            const saveLi = doc.createElement('li');
            saveLi.id = `${ID}-save-reviewed`;
            saveLi.setAttribute('role', 'presentation');
            const saveButton = doc.createElement('button');
            saveButton.type = 'button';
            saveButton.className = 'dropdown-item';
            saveButton.setAttribute('role', 'menuitem');
            saveButton.textContent = '保存并审核';
            saveButton.addEventListener('click', () => setCurrentStage(5, true));
            saveLi.appendChild(saveButton);
            mounted = { li, button, anchor, saveLi, saveButton, saveAnchor: null };
        }
        // 上面是笑脸的“保存并检查”，下面是绿色勾的“保存并审核”。
        const items = [...host.querySelectorAll('.dropdown-item')];
        const nativeCheck = nativeCheckButton(host);
        const firstStatus = items.find(el => /^(标记为已翻译|标记为有疑问|标记为未翻译|Mark as Translated|Mark as Disputed|Mark as Untranslated)$/.test(el.textContent.trim()))?.closest('li') || anchor;
        const saveAnchor = nativeCheck || firstStatus;
        const saveReason = disabledReason(vm, true);
        if (saveReason) {
            if (mounted.saveLi.isConnected) mounted.saveLi.remove();
        } else if (!mounted.saveLi.isConnected || mounted.saveAnchor !== saveAnchor) {
            if (nativeCheck) nativeCheck.after(mounted.saveLi);
            else firstStatus.before(mounted.saveLi);
            mounted.saveAnchor = saveAnchor;
        }
        if (mounted.saveButton.disabled !== Boolean(saveReason)) mounted.saveButton.disabled = Boolean(saveReason);
        const saveTitle = saveReason || '保存当前译文并直接标记为已审核（绿色勾），只处理当前词条';
        if (mounted.saveButton.title !== saveTitle) mounted.saveButton.title = saveTitle;
        const reason = disabledReason(vm);
        if (reason) {
            if (mounted.li.isConnected) mounted.li.remove();
        } else if (!mounted.li.isConnected) {
            anchor.before(mounted.li);
        }
        if (mounted.button.disabled !== Boolean(reason)) mounted.button.disabled = Boolean(reason);
        const title = reason || '直接完成当前词条审核；有修改时一并保存，不批量处理相同词条';
        if (mounted.button.title !== title) mounted.button.title = title;
    }

    // ===== 页面重绘时刷新菜单 =====
    function schedule() {
        if (scheduled) return;
        scheduled = true;
        page.requestAnimationFrame(sync);
    }

    // ===== 功能：普通保存空译文时，保留当前状态 =====
    let emptySaving = null;

    function emptySaveReason(vm, ownPending = false) {
        if (!/^\/projects\/\d+\/strings\/?$/.test(page.location.pathname)) return '请先打开词条编辑页面';
        if ((!ownPending && pending) || vm?.saving) return '正在保存，请稍候';
        if (!vm?.canEdit) return '当前词条不可编辑或由其他成员编辑中';
        if (!Number.isSafeInteger(Number(vm.item?.id)) || Number(vm.item.id) <= 0) return '请先选择词条';
        if (![-1, 0, 1, 2, 3, 5, 9].includes(Number(vm.item.stage))) return '当前词条状态不兼容';
        if (vm.translation !== '') return '译文已变化，请重新保存';
        if (!vm.canSave) return '没有需要保存的译文修改';
        return '';
    }

    function detachEmptySaving() {
        if (!emptySaving) return;
        const { vm, original, wrapper } = emptySaving;
        emptySaving = null;
        if (vm.saveItem === wrapper) {
            vm.saveItem = original;
            if (!vm._isDestroyed && !vm._isBeingDestroyed) vm.$forceUpdate?.();
        }
    }

    function syncEmptySaving() {
        const vm = /^\/projects\/\d+\/strings\/?$/.test(page.location.pathname) ? editorVM() : null;
        if (emptySaving && emptySaving.vm !== vm) detachEmptySaving();
        if (!vm || vm._isDestroyed || vm._isBeingDestroyed || typeof vm.saveItem !== 'function' || emptySaving) return;
        const state = { vm, original: vm.saveItem };
        state.wrapper = function(...args) {
            // 包住原生保存方法，普通按钮和 Ctrl+S / Ctrl+Enter 都能用。
            if (this.translation !== '') return state.original.apply(this, args);
            // 保存非空译文仍走网站原来的检查、排版和批量保存流程。
            // 空译文只保存当前词条，避免改动其他重复词条的状态。
            return setCurrentStage(Number(this.item?.stage), true, true, this);
        };
        emptySaving = state;
        vm.saveItem = state.wrapper;
        vm.$once?.('hook:beforeDestroy', () => { if (emptySaving === state) detachEmptySaving(); });
        vm.$forceUpdate?.();
    }

    // ===== 功能：注释 @ 候选人点击补全 =====
    function keepMentionInputFocused(event) {
        // 候选列表会在输入框失焦时消失，导致点击来不及触发。
        // 鼠标按下时保留焦点，补全文字仍由网站处理。
        if (event.button !== 0 || event.defaultPrevented) return;
        const candidate = event.target?.closest?.('.list-group-item-action');
        if (!candidate || candidate.getAttribute?.('aria-disabled') === 'true') return;
        const list = candidate.closest?.('.user-list');
        const writer = list?.closest?.('.comment-writer');
        if (!writer || candidate.closest?.('.comment-writer') !== writer) return;
        const input = writer.querySelector?.('textarea');
        if (!input || input !== doc.activeElement || input.disabled || input.isConnected === false) return;
        event.preventDefault();
    }

    // 监听页面点击，列表重新渲染后也能生效；无需管理员权限。
    doc.addEventListener('mousedown', keepMentionInputFocused, true);

    // ===== 功能：代码术语的悬浮注释，以及常驻的格式标签说明 =====
    let codeHints = null;
    const hintClass = 'pz-code-hint';

    // 常驻说明放在这里。尖括号和方括号都支持，结束标签也有说明。
    const formatNotes = {
        i: '斜体', em: '斜体', b: '加粗', strong: '加粗', u: '下划线',
        s: '删除线', strike: '删除线', del: '删除线',
        color: '文字颜色', size: '字号', font: '字体',
        sup: '上标', sub: '下标', mark: '高亮背景'
    };
    const formatPattern = /<\/?(?:i|em|b|strong|u|s|strike|del|color|size|font|sup|sub|mark|br)(?:\s+[^<>]*|=[^<>]*)?\s*\/?>|\[\/?(?:i|em|b|strong|u|s|strike|del|color|size|font|sup|sub|mark|br)(?:\s+[^\[\]]*|=[^\[\]]*)?\s*\]/gi;

    function formatHint(token) {
        const match = token.match(/^(?:<|\[)(\/)?([a-z]+)([^<>\[\]]*?)(?:>|\])$/i);
        if (!match) return '';
        const name = match[2].toLowerCase();
        if (name === 'br') return '换行。';
        let meaning = formatNotes[name];
        if (!meaning) return '';
        if (match[1]) return `结束${meaning}，后面的文字恢复外层设置。`;
        const parameter = match[3].trim().replace(/\/$/, '').trim();
        if (name === 'font' && /\bcolor\s*=/i.test(parameter)) meaning = '字体或文字颜色';
        return `开始${meaning}，直到对应的结束标签。` +
            (parameter ? `\n参数：${parameter.replace(/^=\s*/, '')}` : '');
    }

    function termValues(term) {
        return [...(Array.isArray(term.match) ? term.match : []), term.term,
            ...(Array.isArray(term.variants) ? term.variants : [])]
            .filter(value => typeof value === 'string' && value.length);
    }

    function isCodeToken(token) {
        return /^(?:<[^<>]+>|\[\[[^\[\]\r\n]+\]\]|\[[^\[\]\r\n]+\]|⟦[^⟦⟧]+⟧|\{[^{}]+\})$/.test(token);
    }

    function codeKeys(token) {
        const keys = [token];
        // 动态代码也可以用不带括号的名称登记术语，但不匹配代码内的普通单词。
        const body = token.match(/^(?:⟦([^⟦⟧]+)⟧|\[\[([^\[\]]+)\]\]|\{([^{}]+)\})$/);
        if (body) {
            const name = body[1] || body[2] || body[3];
            keys.push(name);
            if (/:[0-9]+$/.test(name)) keys.push(name.replace(/:[0-9]+$/, ''));
        }
        // 登记 <color> 或 [color]，也可以给带颜色参数的同类标签写注释。
        const tag = token.match(/^(<|\[)(\/?[a-z]+)(?:\s+[^<>\[\]]+|=[^<>\[\]]+)(>|\])$/i);
        if (tag) keys.push(tag[1] + tag[2] + tag[3]);
        return keys;
    }

    function glossaryHint(token, terms) {
        const keys = codeKeys(token);
        const entries = terms.filter(term => termValues(term).some(value => keys.some(key =>
            term.caseSensitive ? value === key : value.toLowerCase() === key.toLowerCase())));
        // 自己写的注释优先；重复术语中优先取有说明的那条。
        const term = entries.find(entry => String(entry.note || '').trim()) || entries[0];
        if (!term) return '';
        const note = String(term.note || '').trim();
        const translation = String(term.translation || '').trim();
        const sameCode = [...keys, ...termValues(term)].some(key => key.toLowerCase() === translation.toLowerCase());
        return [translation && !sameCode ? translation : '', note].filter(Boolean).join('\n\n');
    }

    function addCodeHints(html, terms) {
        const box = doc.createElement('div');
        box.innerHTML = html;
        box.normalize();
        const hint = token => glossaryHint(token, terms) || formatHint(token);
        const mark = (el, message) => {
            el.classList.add(hintClass);
            // 用 DOM 属性写注释，术语里的引号、尖括号不会变成网页代码。
            el.setAttribute('title', message);
        };
        for (const el of box.querySelectorAll('var, code')) {
            const message = hint(el.textContent);
            if (message) mark(el, message);
        }
        for (const el of box.querySelectorAll('abbr')) {
            // 未标成粉色、被网站当作普通术语的代码，也去掉下划线。
            if (isCodeToken(el.textContent)) {
                const message = hint(el.textContent) || el.getAttribute('title');
                if (message) mark(el, message);
            }
        }

        // 项目没有把某些格式标成粉色时，也为文字中的这些标签补上说明。
        const literals = [...new Set(terms.flatMap(termValues))].filter(isCodeToken);
        const escaped = literals.sort((a, b) => b.length - a.length)
            .map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const pattern = new RegExp(escaped.length ? `(?:${escaped.join('|')})|${formatPattern.source}` : formatPattern.source, 'gi');
        const walker = doc.createTreeWalker(box, 4);
        const nodes = [];
        while (walker.nextNode()) {
            if (!walker.currentNode.parentElement?.closest(`var, code, abbr, .${hintClass}`)) nodes.push(walker.currentNode);
        }
        for (const node of nodes) {
            const text = node.nodeValue;
            pattern.lastIndex = 0;
            let match, offset = 0, fragment = null;
            while ((match = pattern.exec(text))) {
                const token = match[0], end = match.index + token.length;
                // 不把 [[i]] 这样的动态代码误认成里面的 [i] 格式标签。
                if (token.startsWith('[') && !token.startsWith('[[') &&
                    (text[match.index - 1] === '[' || text[end] === ']')) continue;
                const message = hint(token);
                if (!message) continue;
                fragment ||= doc.createDocumentFragment();
                fragment.appendChild(doc.createTextNode(text.slice(offset, match.index)));
                const span = doc.createElement('span');
                span.textContent = token;
                mark(span, message);
                fragment.appendChild(span);
                offset = end;
            }
            if (fragment) {
                fragment.appendChild(doc.createTextNode(text.slice(offset)));
                node.replaceWith(fragment);
            }
        }
        return box.innerHTML;
    }

    function coreVM() {
        let vm = doc.querySelector('.string-editor .editor-core')?.__vue__;
        for (let count = 0; vm && count < 8; count++, vm = vm.$parent) {
            if (vm.$options?.name === 'editorCore' && !vm._isDestroyed &&
                typeof vm.getHighlightedHtml === 'function') return vm;
        }
        return null;
    }

    function refreshCore(vm) {
        // 仅重新渲染显示；不调用 init，不重置译文、光标或撤销记录。
        vm._computedWatchers?.html?.update?.();
        vm._computedWatchers?.translationGhostHtml?.update?.();
        vm.$forceUpdate?.();
    }

    function detachCodeHints() {
        if (!codeHints) return;
        const { vm, original, wrapper } = codeHints;
        if (vm.getHighlightedHtml === wrapper) {
            vm.getHighlightedHtml = original;
            if (!vm._isDestroyed) refreshCore(vm);
        }
        codeHints = null;
    }

    function syncCodeHints() {
        const vm = /^\/projects\/\d+\/strings\/?$/.test(page.location.pathname) ? coreVM() : null;
        if (codeHints && codeHints.vm !== vm) detachCodeHints();
        if (!vm || codeHints) return;
        if (!doc.getElementById('pz-code-hint-style')) {
            const style = doc.createElement('style');
            style.id = 'pz-code-hint-style';
            style.textContent = `.editor-core .${hintClass} { cursor: help; text-decoration: none !important; border-bottom: 0 !important; }`;
            doc.head.appendChild(style);
        }
        const state = { vm, original: vm.getHighlightedHtml, cache: new Map() };
        state.wrapper = function(...args) {
            const html = state.original.apply(this, args);
            // 只改原文显示，不改覆盖在译文输入框下面的预览层。
            if (args[2] || typeof html !== 'string') return html;
            const terms = Array.isArray(this.terms) ? this.terms : [];
            const key = JSON.stringify([html, terms]);
            if (state.cache.has(key)) return state.cache.get(key);
            const result = addCodeHints(html, terms);
            if (state.cache.size >= 20) state.cache.delete(state.cache.keys().next().value);
            state.cache.set(key, result);
            return result;
        };
        codeHints = state;
        vm.getHighlightedHtml = state.wrapper;
        vm.$once?.('hook:beforeDestroy', () => { if (codeHints === state) detachCodeHints(); });
        refreshCore(vm);
    }

    // ===== 功能：分页加载修复与页码记忆 =====
    let paging = null;

    function positiveNumber(value, maximum = Number.MAX_SAFE_INTEGER) {
        if (!/^\d+$/.test(String(value))) return null;
        const number = Number(value);
        return Number.isSafeInteger(number) && number > 0 && number <= maximum ? number : null;
    }

    function pagingVM() {
        let vm = doc.querySelector('.strings')?.__vue__;
        for (let count = 0; vm && count < 8; count++, vm = vm.$parent) {
            if (vm.$options?.name === 'strings' && typeof vm.fetchStrings === 'function' &&
                typeof vm.initStrings === 'function' && typeof vm.$watch === 'function') return vm;
        }
        return null;
    }

    function pagingKey(vm) {
        // 每个项目、文件和筛选条件分别记忆，只保存页码和每页条数。
        const query = vm.$route.query;
        const filters = Object.keys(query).sort().filter(key =>
            !['page', 'pageSize', 'anchor', 'ref', 'detailed'].includes(key) && query[key] != null)
            .map(key => [key, query[key]]);
        return 'paratranz-tools.paging.' + JSON.stringify([vm.$uid || 0, vm.$route.path, filters]);
    }

    function readPaging(key) {
        try {
            const value = JSON.parse(page.localStorage.getItem(key));
            return positiveNumber(value?.page) && positiveNumber(value?.pageSize, 800) ? value : null;
        } catch { return null; }
    }

    function pagingPlan(state) {
        const vm = state.vm, query = vm.$route.query, key = pagingKey(vm);
        const memory = state.startup ? readPaging(key) : null;
        const explicitPage = positiveNumber(query.page);
        const previous = state.lastPlan;
        const size = positiveNumber(query.pageSize, 800) ||
            (previous?.key === key && previous.route === vm.$route.fullPath ? previous.size : memory?.pageSize || 50);
        const anchor = String(query.anchor || '');
        const sizeChanged = previous?.key === key && previous.size !== size;
        const reloading = page.performance?.getEntriesByType?.('navigation')?.[0]?.type === 'reload';
        // 新的定位链接照常打开；刷新同一链接时，恢复上次实际所在页。
        const restore = !explicitPage && !sizeChanged && memory &&
            (!anchor || (reloading && anchor === memory.anchor));
        let current = explicitPage || (sizeChanged ? 1 : restore ? memory.page :
            previous?.key === key && previous.route === vm.$route.fullPath ? previous.current : anchor ? null : 1);
        if (restore && Number.isSafeInteger(vm.strings?.rowCount) && vm.strings.rowCount >= 0) {
            current = Math.min(current, Math.max(1, Math.ceil(vm.strings.rowCount / size)));
        }
        const overrides = { pageSize: size };
        if (current) {
            overrides.page = current;
            overrides.anchor = undefined;
        }
        return { key, size, current, anchor, overrides, route: vm.$route.fullPath };
    }

    function pagingRouteChanged(state) {
        if (state.route !== state.vm.$route.fullPath) {
            state.route = state.vm.$route.fullPath;
            state.startup = false;
            state.mismatchSince = null;
            state.retried = false;
        }
    }

    function detachPaging() {
        if (!paging) return;
        if (paging.vm.fetchStrings === paging.wrapper) paging.vm.fetchStrings = paging.original;
        for (const unwatch of paging.unwatch) unwatch();
        paging = null;
    }

    function syncPaging() {
        const vm = /^\/projects\/\d+\/strings\/?$/.test(page.location.pathname) ? pagingVM() : null;
        if (paging && paging.vm !== vm) detachPaging();
        if (!vm || vm.$route.query.id) {
            detachPaging();
            return;
        }
        if (!paging) {
            const state = { vm, original: vm.fetchStrings, route: vm.$route.fullPath,
                startup: true, lastPlan: null, mismatchSince: null, retried: false, unwatch: [] };
            state.wrapper = function(extra = {}) {
                pagingRouteChanged(state);
                // 让网站按正确页码读取真实列表，使用网站原有的请求工具。
                const plan = pagingPlan(state);
                state.lastPlan = plan;
                return state.original.call(this, { ...plan.overrides, ...extra });
            };
            paging = state;
            vm.fetchStrings = state.wrapper;
            for (const field of ['$route.fullPath', 'loadStatus', 'strings']) {
                state.unwatch.push(vm.$watch(field, schedule));
            }
            vm.$once?.('hook:beforeDestroy', () => { if (paging === state) detachPaging(); });
        }
        const state = paging;
        pagingRouteChanged(state);
        const plan = pagingPlan(state);
        const data = vm.strings;
        if (vm.loading || !Array.isArray(data?.results)) return;
        const actualPage = positiveNumber(data.page), actualSize = positiveNumber(data.pageSize, 800);
        const mismatch = !actualPage || actualSize !== plan.size || (plan.current && actualPage !== plan.current);
        if (mismatch) {
            state.mismatchSince ??= Date.now();
            const editor = editorVM();
            // 不刷新用户正在修改的草稿；同一次加载异常最多补读一次。
            if (!state.retried && Date.now() - state.mismatchSince >= 1200 &&
                !pending && !editor?.canSave && !editor?.saving) {
                state.retried = true;
                Promise.resolve().then(async () => {
                    if (paging !== state || state.route !== vm.$route.fullPath || vm.loading) return;
                    const activeEditor = editorVM();
                    if (pending || activeEditor?.canSave || activeEditor?.saving) {
                        state.retried = false;
                        return;
                    }
                    const active = vm.active, requestId = vm._StringsReqId, route = vm.$route.fullPath;
                    const result = await vm.fetchStrings();
                    // 读取期间切页、换词条或开始写草稿时，保留当前工作，不应用旧结果。
                    const currentEditor = editorVM();
                    if (paging !== state || route !== vm.$route.fullPath || vm.loading ||
                        vm._StringsReqId !== requestId || vm.active !== active || pending ||
                        currentEditor?.canSave || currentEditor?.saving) return;
                    if (!Array.isArray(result?.results)) return;
                    vm.strings = result;
                    vm.onLoad?.();
                }).catch(error => console.warn('ParaTranz-tools：分页重新读取失败', error?.message)).finally(schedule);
            }
            return;
        }
        state.startup = false;
        if (!plan.current) plan.current = actualPage;
        state.lastPlan = plan;
        state.mismatchSince = null;
        try {
            page.localStorage.setItem(plan.key, JSON.stringify({
                page: actualPage, pageSize: actualSize, anchor: plan.anchor
            }));
        } catch { /* 浏览器不允许存储时，分页仍可正常操作。 */ }
    }

    // ===== 启动与页面切换 =====
    new page.MutationObserver(schedule).observe(doc.body, { childList: true, subtree: true, characterData: true });
    page.setInterval(schedule, 700);
    page.addEventListener('popstate', schedule);
    sync();

})();
