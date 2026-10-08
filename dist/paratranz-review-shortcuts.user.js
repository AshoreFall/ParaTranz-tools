// ==UserScript==
// @name         ParaTranz-tools
// @namespace    local.paratranz.review-shortcut
// @version      1.8.3
// @description  检查与审核、空译文保存、空白格式检查、注释 @ 补全、分页记忆、代码悬浮说明、插件管理，以及疑问分组和项目共享。
// @match        https://paratranz.cn/projects/*/strings*
// @match        https://paratranz.cn/projects/*/issues*
// @match        https://paratranz.cn/projects/*/settings*
// @grant        unsafeWindow
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/AshoreFall/ParaTranz-tools/main/dist/paratranz-review-shortcuts.meta.js
// @downloadURL  https://raw.githubusercontent.com/AshoreFall/ParaTranz-tools/main/dist/paratranz-review-shortcuts.user.js
// ==/UserScript==

(() => {
    'use strict';

    // 功能：检查/审核、空译文保存、保存菜单、注释 @ 补全、代码悬浮说明、分页修复与页码记忆。插件管理、疑问分组和空白检查在文件末尾。
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
    let ordinarySaveControl = null;

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
                tell(vm, 'success', preserveStage ? `空译文已保存，状态保留为${stageName(targetStage)}` :
                    `词条已标记为${stageName(targetStage)}`);
            } else {
                tell(vm, 'success', preserveStage ? `原词条 ${id} 的空译文已保存，状态保留为${stageName(targetStage)}；当前编辑内容已保留。` :
                    `原词条 ${id} 已标记为${stageName(targetStage)}；当前编辑内容已保留。`);
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

    // ===== 功能：蓝标显示“检查”，主按钮保留网站的审核权限限制 =====
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
        control.button.removeAttribute('data-pz-main-action');
        control.button.removeAttribute('data-pz-checking');
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
        // 自己检查过、网站不允许继续审核时，恢复原生“保存”。直接审核只在小箭头菜单里。
        const target = !vm.canReview ? null : stage === 3 ? 5 : stage > 0 && stage < 3 ? 3 : null;
        if (mainControl && (mainControl.vm !== vm || mainControl.button !== button || vm.canSave || !target || !vm.canEdit)) restoreMainButton();
        if (!button || vm.canSave || !target || !vm.canEdit) return;
        const toggle = dropdown.querySelector('button.dropdown-toggle');
        if (!mainControl) {
            const handler = event => {
                event.preventDefault();
                event.stopImmediatePropagation();
                const current = editorVM(), currentStage = Number(current?.item?.stage);
                if (current !== vm || pending || current.saving) return;
                // Vue 会复用这个按钮；输入译文或切到未翻译词条后，旧的检查监听可能还没清理。
                // 此时明确走原生保存，成功后的下一条跳转也由网站处理，避免吞掉点击或跳两次。
                if (current.canSave) {
                    restoreMainButton();
                    if (current.canEdit) Promise.resolve(current.saveItem()).catch(error =>
                        tell(current, 'error', error?.message || '保存失败，请稍后重试'));
                    return;
                }
                if (!current.canReview || !allowed(current)) return;
                if (currentStage === 3) setCurrentStage(5);
                else if (currentStage > 0 && currentStage < 3) setCurrentStage(3);
            };
            // 不往 Vue 管理的按钮内部插入图标，避免切换“审核/保存”时图标叠在一起。
            if (doc.head && !doc.getElementById('pz-main-action-style')) {
                const style = doc.createElement('style');
                style.id = 'pz-main-action-style';
                // 复用原生 fa-fw 图标，只换字形；大小、基线、留白都与“保存”一致。
                style.textContent = '[data-pz-main-action="3"] > i::before { content: "\\f118" !important; }' +
                    '[data-pz-checking] > i { animation: pz-smile-nod .7s ease-in-out infinite !important; }' +
                    '@keyframes pz-smile-nod { 0%, 100% { transform: rotate(-7deg); } 50% { transform: translateY(-2px) rotate(7deg) scale(1.08); } }' +
                    '@media (prefers-reduced-motion: reduce) { [data-pz-checking] > i { animation: none !important; } }';
                doc.head.appendChild(style);
            }
            const styles = new Map();
            for (const element of [button, toggle].filter(Boolean)) {
                styles.set(element, ['background-color', 'background-image', 'border-color', 'border-left-color', 'color'].map(property =>
                    [property, element.style.getPropertyValue(property), element.style.getPropertyPriority(property)]));
            }
            mainControl = { button, handler, styles, vm,
                originalTitle: button.title, english: /\b(Review|Save)\b/.test(button.textContent) };
            button.addEventListener('click', handler, true);
        }
        const text = target === 3 ? '检查' : '审核';
        const color = target === 3 ? '#20c997' : '#28a745';
        mainLabel(button, text);
        button.title = text;
        button.disabled = Boolean(disabledReason(vm));
        if (button.getAttribute('data-pz-main-action') !== String(target)) button.setAttribute('data-pz-main-action', String(target));
        // 检查提交期间让笑脸轻轻晃动；审核仍用网站原有的勾和转圈图标。
        if (target === 3 && (pending || vm.saving)) {
            if (button.getAttribute('data-pz-checking') !== 'true') button.setAttribute('data-pz-checking', 'true');
        } else button.removeAttribute('data-pz-checking');
        for (const element of mainControl.styles.keys()) {
            // 网站按钮自带绿色渐变，必须去掉它，才能显示“已检查”徽标的青绿色。
            for (const [property, value] of [['background-color', color], ['border-color', color], ['color', '#fff']]) {
                if (element.style.getPropertyValue(property) !== value) element.style.setProperty(property, value, 'important');
            }
            if (target === 3) element.style.setProperty('background-image', 'none', 'important');
            else {
                const [, value, priority] = mainControl.styles.get(element).find(([property]) => property === 'background-image');
                if (value) element.style.setProperty('background-image', value, priority);
                else element.style.removeProperty('background-image');
            }
            // 给小箭头保留原生分隔线，纯色背景下也能看清主按钮的边界。
            if (element === toggle && target === 3) element.style.setProperty('border-left-color', '#1baa80', 'important');
            else {
                const [, value, priority] = mainControl.styles.get(element).find(([property]) => property === 'border-left-color');
                if (value) element.style.setProperty('border-left-color', value, priority);
                else element.style.removeProperty('border-left-color');
            }
        }
    }

    function sync() {
        scheduled = false;
        // 管理页使用同一个页面刷新入口；它出错时仍保留编辑器的正常保存。
        try { page.ParaTranzPluginManager?.sync?.(); }
        catch (error) { console.warn('ParaTranz-tools：插件页刷新失败', error?.message); }
        try { page.ParaTranzDisputeGroups?.sync?.(); }
        catch (error) { console.warn('ParaTranz-tools：疑问分组刷新失败', error?.message); }
        try { page.ParaTranzWhitespaceCheck?.sync?.(); }
        catch (error) { console.warn('ParaTranz-tools：空白检查刷新失败', error?.message); }
        syncPaging();
        rememberPagingURL();
        syncEmptySaving();
        syncOrdinarySaving();
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

    // ===== 功能：所有状态的普通保存按钮始终使用当前编辑器 =====
    function detachOrdinarySaving() {
        if (!ordinarySaveControl) return;
        ordinarySaveControl.button.removeEventListener('click', ordinarySaveControl.handler, true);
        ordinarySaveControl = null;
    }

    function syncOrdinarySaving() {
        const vm = /^\/projects\/\d+\/strings\/?$/.test(page.location.pathname) ? editorVM() : null;
        const host = vm && doc.querySelector('.string-editor');
        const dropdown = host?.querySelector?.('.right.text-right .b-dropdown') || host?.querySelector?.('.b-dropdown');
        const button = [...(dropdown?.parentElement?.children || [])].find(el =>
            el.tagName === 'BUTTON' && el.classList.contains('btn'));
        if (ordinarySaveControl && (ordinarySaveControl.vm !== vm || ordinarySaveControl.button !== button ||
            !ordinarySaveControl.button.isConnected)) detachOrdinarySaving();
        if (!vm || !button || typeof vm.saveItem !== 'function') return;
        if (!ordinarySaveControl) {
            const control = { vm, button, inFlight: false, handler: null };
            const handler = async event => {
                const current = editorVM();
                // 没有译文修改时仍由原生检查/审核处理，不把保存变成再次审核。
                if (current !== vm || !button.isConnected || !current.canSave) return;
                event.preventDefault();
                event.stopImmediatePropagation();
                if (pending || current.saving || control.inFlight || !current.canEdit) return;
                restoreMainButton();
                control.inFlight = true;
                button.disabled = true;
                // 不沿用按钮重绘前绑定的处理方法；初始就是已检查/已审核的词条也走此入口。
                try {
                    await current.saveItem();
                } catch (error) {
                    tell(current, 'error', error?.message || '保存失败，请稍后重试');
                } finally {
                    control.inFlight = false;
                    if (ordinarySaveControl === control) syncOrdinarySaving();
                }
            };
            control.handler = handler;
            ordinarySaveControl = control;
            button.addEventListener('click', handler, true);
            vm.$once?.('hook:beforeDestroy', () => {
                if (ordinarySaveControl?.vm === vm) detachOrdinarySaving();
            });
        }
        // 修复旧检查按钮遗留的禁用状态，只在网站确认当前译文可保存时恢复点击。
        if (vm.canSave && vm.canEdit) button.disabled = Boolean(pending || vm.saving || ordinarySaveControl.inFlight);
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
        // 根节点可能被路由外壳占用；从已经识别的词条编辑器向上找也能找到列表。
        const starts = [editorVM(), doc.querySelector('.strings')?.__vue__,
            doc.querySelector('.strings .pagination-footer')?.__vue__];
        for (let vm of starts) {
            for (let count = 0; vm && count < 16; count++, vm = vm.$parent) {
                if (vm.$options?.name === 'strings' && !vm._isDestroyed && !vm._isBeingDestroyed &&
                    typeof vm.fetchStrings === 'function' && typeof vm.initStrings === 'function' &&
                    typeof vm.$watch === 'function') return vm;
            }
        }
        return null;
    }

    // ===== 功能：刷新前记录位置，页面最早加载时处理旧的词条定位 =====
    function pagingURL() {
        if (typeof page.URL !== 'function' || !page.location.href) return null;
        const url = new page.URL(page.location.href);
        return /^\/projects\/\d+\/strings\/?$/.test(url.pathname) && !url.searchParams.has('id') ? url : null;
    }

    function pagingURLKey(url) {
        const filters = [...url.searchParams].filter(([key]) => !['page', 'pageSize', 'anchor', 'ref', 'detailed'].includes(key));
        filters.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
        return 'paratranz-tools.refresh.' + JSON.stringify([url.pathname, filters]);
    }

    function rememberPagingURL() {
        const url = pagingURL();
        if (!url) return;
        const vm = pagingVM();
        const data = vm && !vm.loading ? vm.strings : null;
        const current = positiveNumber(url.searchParams.get('page')) || positiveNumber(data?.page) || 1;
        const size = positiveNumber(url.searchParams.get('pageSize'), 800) || positiveNumber(data?.pageSize, 800) || 50;
        // 只有当前列表确实属于这一页，才记住选中的词条；不沿用另一页的旧 anchor。
        const selected = Number(data?.page) === current && Number(data?.pageSize) === size &&
            data?.results?.some(item => Number(item.id) === Number(vm.active)) ? String(vm.active) : '';
        try {
            page.sessionStorage.setItem(pagingURLKey(url), JSON.stringify({ page: current, pageSize: size, selected }));
        } catch { /* 存储不可用时，刷新仍按地址中的页码加载。 */ }
    }

    function restorePagingURL() {
        const url = pagingURL();
        const reloading = page.performance?.getEntriesByType?.('navigation')?.[0]?.type === 'reload' ||
            page.performance?.navigation?.type === 1;
        if (!url || !reloading || typeof page.history?.replaceState !== 'function') return;
        let memory;
        try { memory = JSON.parse(page.sessionStorage.getItem(pagingURLKey(url))); } catch { /* 无记忆也可清理旧定位。 */ }
        const current = positiveNumber(url.searchParams.get('page')) || positiveNumber(memory?.page);
        if (!current) return;
        const size = positiveNumber(url.searchParams.get('pageSize'), 800) || positiveNumber(memory?.pageSize, 800) || 50;
        url.searchParams.set('page', String(current));
        url.searchParams.set('pageSize', String(size));
        if (Number(memory?.page) === current && Number(memory?.pageSize) === size && positiveNumber(memory?.selected)) {
            url.searchParams.set('anchor', memory.selected);
        } else url.searchParams.delete('anchor');
        // document-start 时先整理地址，网站的第一条请求就不会被旧 anchor 拉回别的页。
        if (url.href !== page.location.href) page.history.replaceState(page.history.state, '', url.href);
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
        const grouped = page.ParaTranzDisputeGroups?.managesRoute?.(query);
        const size = grouped ? 10 : positiveNumber(query.pageSize, 800) ||
            (previous?.key === key && previous.route === vm.$route.fullPath ? previous.size : memory?.pageSize || 50);
        const anchor = String(query.anchor || '');
        const sizeChanged = previous?.key === key && previous.size !== size;
        const reloading = page.performance?.getEntriesByType?.('navigation')?.[0]?.type === 'reload';
        // 刷新时以记住的实际页为准，不能让地址里残留的 page=1 覆盖它。
        // 新打开的定位链接、手动切页仍按链接和用户选择处理。
        const restore = !sizeChanged && memory && (!grouped || memory.pageSize === 10) &&
            (reloading ? anchor === memory.anchor : !explicitPage && !anchor);
        let current = restore ? memory.page : explicitPage || (sizeChanged ? 1 :
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
            state.routeSync = null;
        }
    }

    function syncPagingRoute(state, current, size) {
        const vm = state.vm, query = vm.$route.query;
        // 网站页码优先读取地址栏；只改返回的数据，会出现列表在第 3 页、页码仍为 1。
        if ((positiveNumber(query.page) || 1) === current &&
            (positiveNumber(query.pageSize, 800) || 50) === size) return;
        if (typeof vm.$router?.replace !== 'function' || state.routeSync === vm.$route.fullPath) return;
        const editor = editorVM();
        if (pending || vm.loading || editor?.canSave || editor?.saving) return;
        const next = { ...query, page: String(current), pageSize: String(size) };
        // 换地址时仍定位当前词条，避免网站重新加载后选回旧的 anchor。
        if (vm.strings.results.some(item => Number(item.id) === Number(vm.active))) next.anchor = String(vm.active);
        else delete next.anchor;
        state.routeSync = vm.$route.fullPath;
        Promise.resolve(vm.$router.replace({ path: vm.$route.path, query: next, hash: vm.$route.hash }))
            .catch(error => console.warn('ParaTranz-tools：分页地址同步失败', error?.message)).finally(schedule);
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
                startup: true, lastPlan: null, mismatchSince: null, retried: false, routeSync: null, unwatch: [] };
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
        const grouped = page.ParaTranzDisputeGroups?.managesRoute?.(vm.$route.query);
        const mismatch = !actualPage || actualSize !== plan.size || (!grouped && plan.current && actualPage !== plan.current);
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
        syncPagingRoute(state, actualPage, actualSize);
    }

    // ===== 启动与页面切换 =====
    restorePagingURL();
    function start() {
        new page.MutationObserver(schedule).observe(doc.body, { childList: true, subtree: true, characterData: true });
        page.setInterval(schedule, 700);
        sync();
    }
    if (doc.body) start();
    else doc.addEventListener('DOMContentLoaded', start, { once: true });
    page.addEventListener('pagehide', rememberPagingURL);
    page.addEventListener('beforeunload', rememberPagingURL);
    page.addEventListener('popstate', schedule);
    // 输入框的 value 变化不会触发 DOM 观察；及时卸下旧的检查监听，恢复保存按钮。
    doc.addEventListener('input', event => {
        if (event.target?.closest?.('.string-editor')) schedule();
    }, true);
    // 冒泡阶段在页面的 v-model 更新之后运行，不必等下一次轮询才恢复保存。
    doc.addEventListener('input', event => {
        if (event.target?.closest?.('.string-editor')) syncOrdinarySaving();
    });

})();

// ===== 功能：插件管理页、自动发现、项目规则与更新提示 =====
(() => {
    'use strict';
    const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const doc = page.document;
    const KEY = 'paratranz-tools.plugins.v1';
    const nativeLabel = /^(建议|Suggestions?|历史|History|术语\s*\d*|Terms?\s*\d*|注释\s*\d*|Notes?\s*\d*)$/i;
    const clients = new Map(), updates = new Map(), expanded = new Set();
    let store;
    try { store = JSON.parse(page.localStorage.getItem(KEY)); } catch { /* 首次使用 */ }
    if (!store || typeof store !== 'object' || Array.isArray(store)) store = {};
    let mounted = null, queued = false, activating = false, signature = '', selected = null, opened = false;
    let scope = 'project', currentContext = '', observer = null;
    const sourceItems = new Set(), masked = new Set(), nativeActive = new Set(), styledPanels = new Set(), styledSettings = new Set();
    const own = (object, key) => Object.prototype.hasOwnProperty.call(object || {}, key);
    const validId = id => typeof id === 'string' && id.length > 0 && id.length < 200 &&
        !['__proto__', 'prototype', 'constructor', 'ParaTranz-tools'].includes(id);
    const clone = value => JSON.parse(JSON.stringify(value || {}));
    function context() {
        const projectId = /^\/projects\/(\d+)\/strings\/?$/.exec(page.location.pathname)?.[1] || '';
        let vm = doc.querySelector('.string-editor')?.__vue__, userId = '0';
        for (let i = 0; vm && i < 16; i++, vm = vm.$parent) {
            if (vm.$uid) { userId = String(vm.$uid); break; }
        }
        return { projectId, userId };
    }
    function userStore() {
        const { userId } = context();
        if (!own(store, userId) || !store[userId]?.global || !store[userId]?.projects) {
            store[userId] = { global: {}, projects: {} };
        }
        return store[userId];
    }
    // ---- 按项目保存规则 ----
    function rule(id, projectId = context().projectId) {
        const data = userStore(), global = own(data.global, id) ? data.global[id] : {};
        const project = own(data.projects, projectId) && own(data.projects[projectId], id) ? data.projects[projectId][id] : {};
        return { enabled: global.enabled !== false && project.excluded !== true,
            collect: project.collect ?? global.collect ?? true,
            config: clone(project.independent ? project.config : global.config),
            independent: project.independent === true, excluded: project.excluded === true };
    }
    function persist() { page.localStorage.setItem(KEY, JSON.stringify(store)); }
    function queue() {
        if (queued) return;
        queued = true;
        page.requestAnimationFrame(() => { queued = false; sync(); });
    }
    // ---- 自动识别额外页签 ----
    function controls(nav) {
        return [...nav.children].flatMap(item => {
            const tab = item.matches?.('.nav-link,[role="tab"]') ? item : item.querySelector?.('.nav-link,[role="tab"]');
            const title = tab?.textContent.trim();
            if (!title || nativeLabel.test(title) || /^ParaTranz-tools$/i.test(title) || tab.closest('[data-pz-plugin-manager]')) return [];
            const panelId = tab.getAttribute('aria-controls') || (tab.getAttribute('href')?.startsWith('#') ? tab.getAttribute('href').slice(1) : '');
            const panel = panelId ? doc.getElementById(panelId) : null;
            const sorcery = tab.__sorceryTabController;
            const metadata = sorcery ? page.SorceryParaTranzReviewBundle : null;
            return [{ id: tab.getAttribute('data-plugin-id') || tab.id || `tab:${title}`, title, item, tab,
                panel: panel && mounted.sidebar.contains(panel) ? panel : null,
                controller: sorcery || null,
                version: tab.getAttribute('data-plugin-version') || metadata?.VERSION || '',
                updateURL: tab.getAttribute('data-plugin-update-url') || '',
                homepage: metadata?.UPDATE_URL || '' }];
        });
    }
    function entries() {
        if (!mounted) return [];
        const found = controls(mounted.nav), result = new Map();
        for (const entry of found) if (validId(entry.id)) result.set(entry.id, entry);
        for (const [id, client] of clients) {
            const auto = found.find(entry => entry.tab === client.tab || entry.id === id || entry.title === client.title);
            if (auto) result.delete(auto.id);
            result.set(id, { ...auto, ...client, id, client,
                tab: client.tab?.isConnected ? client.tab : auto?.tab,
                panel: client.panel?.isConnected ? client.panel : auto?.panel });
        }
        return [...result.values()];
    }
    function fieldSchema(entry) {
        // 注册接口只接收明确声明的普通设置；密钥保留在各插件自己的设置里。
        return (Array.isArray(entry.fields) ? entry.fields : []).filter(field => field && validId(field.key) &&
            /^[a-zA-Z][\w.-]*$/.test(field.key) && !/token|secret|password|api.?key|authorization/i.test(field.key) &&
            ['boolean', 'number', 'string', 'select'].includes(field.type));
    }
    function effective(entry) {
        const state = rule(entry.id), values = {};
        for (const field of fieldSchema(entry)) values[field.key] = own(state.config, field.key) ? state.config[field.key] : field.default;
        return { ...state, config: values, ...context() };
    }
    // ---- 应用插件的启停和配置 ----
    function apply(entry, state = effective(entry)) {
        if (!entry.client) return Promise.resolve();
        const client = entry.client, stamp = JSON.stringify(state);
        if (client.applied === stamp) return Promise.resolve();
        if (client.applying === stamp) return client.task;
        const ctx = { projectId: state.projectId, userId: state.userId };
        client.applying = stamp;
        client.task = (client.task || Promise.resolve()).catch(() => {}).then(async () => {
            if (typeof entry.setEnabled === 'function') await entry.setEnabled(state.enabled, ctx);
            if (state.enabled && typeof entry.applyConfig === 'function') await entry.applyConfig(clone(state.config), ctx);
            client.applied = stamp;client.failed = '';
        }).catch(error => { client.failed = stamp;throw error; }).finally(() => {
            if (client.applying === stamp) client.applying = '';
            queue();
        });
        return client.task;
    }
    async function change(entry, patch) {
        const data = userStore(), { projectId } = context();
        const area = scope === 'global' ? data.global : (data.projects[projectId] ||= {});
        const previous = own(area, entry.id) ? clone(area[entry.id]) : undefined;
        area[entry.id] = { ...(previous || {}), ...patch };
        try {
            await apply(entry);
            persist();
            signature = '';
            queue();
        } catch (error) {
            if (previous) area[entry.id] = previous; else delete area[entry.id];
            if (entry.client) { entry.client.applied = '';entry.client.failed = ''; }
            await apply(entry).catch(() => {});
            status(error?.message || '设置未能应用，请重试');
            signature = '';queue();return false;
        }
        return true;
    }
    function status(message) { if (mounted) mounted.status.textContent = message; }
    function node(tag, text, className) {
        const element = doc.createElement(tag);
        if (text != null) element.textContent = text;
        if (className) element.className = className;
        return element;
    }
    function button(text, action) {
        const element = node('button', text, 'btn btn-sm btn-outline-primary');
        element.type = 'button';
        element.addEventListener('click', action);
        return element;
    }
    function iconButton(kind, label, action, className) {
        const element = button('', action);element.className = className;
        element.setAttribute('aria-label', label);element.title = label;
        const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');svg.setAttribute('aria-hidden', 'true');svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');svg.setAttribute('stroke-width', '1.8');svg.setAttribute('stroke-linecap', 'round');svg.setAttribute('stroke-linejoin', 'round');
        const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', kind === 'back' ? 'M19 12H5m6-6-6 6 6 6' : 'm6 9 6 6 6-6');svg.append(path);element.append(svg);
        return element;
    }
    function toggle(text, checked, action, available = true) {
        const label = node('label'), input = node('input'); input.type = 'checkbox';
        input.checked = checked; input.disabled = !available;
        input.addEventListener('change', async () => {
            const previous = checked;
            input.disabled = true;
            try { if (await action(input.checked) === false) input.checked = previous; }
            catch (error) { input.checked = previous;status(error?.message || '设置保存失败'); }
            finally { input.disabled = !available; }
        });
        label.append(input, doc.createTextNode(' ' + text));
        return label;
    }
    function paneRoots() {
        if (!mounted) return [];
        const roots = [...(mounted.sidebar.querySelector('.tabs')?.children || [])];
        for (const entry of entries()) if (entry.panel && !roots.some(root => root.contains(entry.panel))) roots.push(entry.panel);
        return roots.filter(root => root !== mounted.root && !root.contains(mounted.root));
    }
    function unmask() { for (const root of masked) root.removeAttribute('data-pz-plugin-masked'); masked.clear(); }
    function restoreActive() {
        for (const link of nativeActive) if (link.isConnected) link.classList.add('active');
        nativeActive.clear();
    }
    function hideNativeActive() {
        if (!mounted) return;
        for (const link of mounted.nav.querySelectorAll('.nav-link.active')) {
            if (nativeLabel.test(link.textContent.trim())) { nativeActive.add(link);link.classList.remove('active'); }
        }
    }
    function mask() {
        if (!opened) { unmask();return; }
        const active = selected && entries().find(entry => entry.id === selected);
        // 未声明关联面板的旧插件由其原生点击处理控制内容，不猜测、搬动 Vue 节点。
        if (active && !active.panel) { unmask();return; }
        const next = new Set();
        for (const root of paneRoots()) {
            if (active?.panel && (root === active.panel || root.contains(active.panel))) continue;
            next.add(root);
        }
        for (const root of masked) if (!next.has(root)) root.removeAttribute('data-pz-plugin-masked');
        for (const root of next) if (!masked.has(root)) root.setAttribute('data-pz-plugin-masked', '');
        masked.clear();for (const root of next) masked.add(root);
    }
    function close() {
        opened = false; selected = null; unmask();restoreActive();
        if (mounted) { mounted.root.hidden = true;mounted.viewBar.hidden = true; mounted.tab.classList.remove('active');mounted.tab.setAttribute('aria-selected', 'false'); }
    }
    function show() {
        const active = selected && entries().find(entry => entry.id === selected);
        // 使用校对脚本已有的隐藏接口，保留它的设置和草稿；不销毁插件。
        active?.controller?.hide?.();
        opened = true; selected = null; signature = '';
        if (mounted) {
            mounted.root.hidden = false;mounted.root.style.removeProperty('display');
            mounted.viewBar.hidden = true;mounted.tab.classList.add('active');
        }
        sync();
    }
    async function openEntry(entry, configure = false) {
        // 卡片仍在时，页面可能已经换过一次节点；始终使用当前入口。
        entry = entries().find(item => item.id === entry.id) || entry;
        if (!configure && typeof entry.setEnabled === 'function' && !rule(entry.id).enabled) {
            status('这个插件已停用，请先启用。');return;
        }
        opened = true; selected = entry.id; unmask();
        if (mounted) {
            mounted.root.hidden = true;mounted.viewBar.hidden = false;mounted.viewBar.style.removeProperty('display');mounted.viewTitle.textContent = entry.title;
        }
        try {
            activating = true;
            if (typeof entry.open === 'function') await entry.open({ ...context() });
            else if (entry.tab?.isConnected) entry.tab.click();
            else throw new Error('插件入口暂未加载，请稍后再试');
        } catch (error) {
            selected = null;signature = '';sync();status(error?.message || '无法打开插件');
        }
        finally { activating = false; }
        page.requestAnimationFrame(async () => {
            if (!mounted || !opened || selected !== entry.id) return;
            const active = entries().find(item => item.id === entry.id) || entry;
            if (configure) {
                if (typeof active.configure === 'function') {
                    try { await active.configure({ ...context() }); }
                    catch (error) { selected = null;signature = '';sync();status(error?.message || '无法打开配置'); }
                }
                else {
                    // 部分旧插件没有 aria-controls；打开后只寻找右侧当前可见的配置入口。
                    const settings = [...((active.panel || mounted.sidebar).querySelectorAll('button,a,[role="button"]'))].find(control =>
                        !control.closest('[data-pz-plugin-manager]') &&
                        (active.panel || control.getClientRects?.().length > 0) &&
                        (/^(设置|配置(?:翻译)?|Settings|Configuration|Configure)$/i.test(control.textContent.trim()) ||
                        /^(设置|配置|Settings)$/i.test(control.getAttribute('title') || control.getAttribute('aria-label') || '')));
                    if (settings) settings.click();
                    // 原插件已正常打开；不再插入遮挡面板的提示文字。
                }
            }
            signature = ''; sync();
        });
    }
    // ---- 版本检查和更新提示 ----
    function safeURL(value) {
        try {
            const url = new page.URL(value);
            if (url.protocol !== 'https:' || url.username || url.password || [...url.searchParams.keys()].some(key => /token|key|password|secret/i.test(key))) return '';
            return url.href;
        } catch { return ''; }
    }
    function compareVersions(left, right) {
        const parse = value => /^(?:v)?(\d+(?:\.\d+)*)(?:-([\w.-]+))?(?:\+[\w.-]+)?$/.exec(String(value));
        const a = parse(left), b = parse(right); if (!a || !b) return null;
        const x = a[1].split('.').map(Number), y = b[1].split('.').map(Number);
        for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1;
        if (!a[2] && b[2]) return 1; if (a[2] && !b[2]) return -1;
        if (a[2] === b[2]) return 0;
        return a[2].localeCompare(b[2], 'en', { numeric: true }) > 0 ? 1 : -1;
    }
    async function checkUpdate(entry) {
        entry = entries().find(item => item.id === entry.id) || entry;
        const url = safeURL(entry.updateURL);
        if (!url || !entry.version) return;
        const previous = updates.get(entry.id);
        if (previous?.pending) return;
        const metadataKey = JSON.stringify([entry.version, url, entry.metadataName]);
        updates.set(entry.id, { pending: true, metadataKey, message: '正在检查更新…' }); signature = ''; queue();
        const controller = new page.AbortController(), timeout = page.setTimeout(() => controller.abort(), 8000);
        try {
            const response = await page.fetch(url, { credentials: 'omit', signal: controller.signal });
            if (!response.ok) throw new Error('无法读取更新信息');
            const source = await response.text();
            if (updates.get(entry.id)?.metadataKey !== metadataKey) return;
            const version = /^\s*\/\/\s*@version\s+(\S+)/m.exec(source)?.[1];
            const name = /^\s*\/\/\s*@name\s+(.+)/m.exec(source)?.[1]?.trim();
            if (!version || (entry.metadataName && name !== entry.metadataName)) throw new Error('更新文件与插件信息不符');
            const comparison = compareVersions(version, entry.version);
            if (comparison == null) throw new Error('暂时无法比较这个版本号');
            const download = safeURL(entry.downloadURL || /^\s*\/\/\s*@downloadURL\s+(\S+)/m.exec(source)?.[1] || (/\.user\.js(?:\?|$)/.test(url) ? url : ''));
            updates.set(entry.id, { version, download, metadataKey, available: comparison > 0,
                message: comparison > 0 ? `有更新：${version}` : '已是最新版本', checkedAt: Date.now() });
        } catch (error) {
            if (updates.get(entry.id)?.metadataKey === metadataKey) updates.set(entry.id, { metadataKey, message: error?.message || '更新检查失败，可稍后重试' });
        }
        finally { page.clearTimeout(timeout); signature = ''; queue(); }
    }
    // ---- 插件管理页 ----
    function renderCard(entry) {
        const card = node('article', null, 'pz-plugin-card'), current = rule(entry.id), schema = fieldSchema(entry);
        const global = userStore().global[entry.id] || {};
        const state = scope === 'global' ? { ...current, enabled: global.enabled !== false, collect: global.collect !== false } : current;
        const head = node('div', null, 'pz-plugin-card-head');
        const identity = node('div', null, 'pz-plugin-identity');identity.append(node('strong', entry.title));
        if (entry.version) identity.append(node('span', `v${entry.version}`, 'text-muted'));
        const actions = node('div', null, 'pz-plugin-actions');
        const open = button('打开', () => openEntry(entry));open.className = 'pz-plugin-open';
        const disclosure = iconButton('down', `${expanded.has(entry.id) ? '收起' : '展开'} ${entry.title} 配置`, () => {
            if (expanded.has(entry.id)) expanded.delete(entry.id);else expanded.add(entry.id);
            signature = '';sync();
        }, 'pz-plugin-disclosure');
        disclosure.setAttribute('aria-expanded', String(expanded.has(entry.id)));
        actions.append(open, disclosure);head.append(identity, actions);
        card.append(head);
        const details = node('div', null, 'pz-plugin-details');details.hidden = !expanded.has(entry.id);
        details.id = `pz-plugin-config-${encodeURIComponent(entry.id)}`;disclosure.setAttribute('aria-controls', details.id);
        const extraActions = node('div', null, 'pz-plugin-extra-actions');
        extraActions.append(button('插件设置', () => openEntry(entry, true)));
        if (safeURL(entry.updateURL) && entry.version) {
            const update = button('检查更新', () => checkUpdate(entry));
            update.disabled = !!updates.get(entry.id)?.pending;
            extraActions.append(update);
        }
        const updateState = updates.get(entry.id);
        if (updateState?.available && updateState.download) {
            const link = node('a', '更新', 'btn btn-sm btn-primary');link.href = updateState.download;link.target = '_blank';link.rel = 'noopener noreferrer';extraActions.append(link);
        } else if (safeURL(entry.homepage) && !entry.updateURL) {
            const link = node('a', '作者更新', 'btn btn-sm btn-outline-secondary');link.href = safeURL(entry.homepage);link.target = '_blank';link.rel = 'noopener noreferrer';extraActions.append(link);
        }
        details.append(extraActions);
        if (updateState?.message) card.append(node('p', updateState.message, 'pz-plugin-update'));
        const rules = node('div', null, 'pz-plugin-rules');
        rules.append(toggle('收进插件页', state.collect, value => change(entry, { collect: value })));
        const canControl = typeof entry.setEnabled === 'function';
        if (canControl) rules.append(scope === 'project'
            ? toggle('排除本项目', state.excluded, value => change(entry, { excluded: value }), canControl)
            : toggle('启用插件', state.enabled, value => change(entry, { enabled: value }), canControl));
        const canConfigure = typeof entry.applyConfig === 'function' && schema.length > 0;
        if (scope === 'project' && canConfigure) rules.append(toggle('本项目独立设置', state.independent, value =>
            change(entry, { independent: value, config: value ? clone(effective(entry).config) : state.config }), canConfigure));
        details.append(rules);
        if (entry.client?.failed) card.append(node('p', '设置应用失败，未确认运行状态。', 'pz-plugin-note'));
        if (canConfigure && (scope === 'global' || state.independent)) {
            const values = scope === 'global' ? Object.fromEntries(schema.map(field =>
                [field.key, own(global.config, field.key) ? global.config[field.key] : field.default])) : effective(entry).config;
            const ownerContext = JSON.stringify(context());
            const form = node('div', null, 'pz-plugin-fields');
            for (const field of schema) {
                const label = node('label', field.label || field.key), input = node(field.type === 'select' ? 'select' : 'input');
                if (field.type === 'select') for (const option of field.options || []) {
                    const item = node('option', typeof option === 'object' ? option.label : option);item.value = typeof option === 'object' ? option.value : option;input.append(item);
                } else input.type = field.type === 'boolean' ? 'checkbox' : field.type === 'number' ? 'number' : 'text';
                if (field.type === 'boolean') input.checked = values[field.key] === true;
                else input.value = String(values[field.key] ?? '');
                if (field.min != null) input.min = field.min;if (field.max != null) input.max = field.max;
                input.addEventListener('change', async () => {
                    if (JSON.stringify(context()) !== ownerContext) { status('项目已变化，请在当前项目重新设置');return; }
                    const value = field.type === 'boolean' ? input.checked : field.type === 'number' ? Number(input.value) : input.value;
                    if (field.type === 'number' && (!Number.isFinite(value) || field.min != null && value < field.min || field.max != null && value > field.max)) { status('数值超出可用范围');return; }
                    const data = userStore(), raw = scope === 'global' ? data.global[entry.id] : data.projects[context().projectId]?.[entry.id];
                    await change(entry, { config: { ...(raw?.config || values), [field.key]: value } });
                });
                label.append(input);form.append(label);
            }
            details.append(form);
        }
        card.append(details);
        return card;
    }
    function restoreSources() { for (const item of sourceItems) item.removeAttribute('data-pz-plugin-collected');sourceItems.clear(); }
    function teardown() {
        restoreSources();unmask();restoreActive();
        for (const panel of styledPanels) panel.removeAttribute('data-pz-plugin-panel');styledPanels.clear();
        for (const control of styledSettings) control.classList.remove('pz-plugin-settings-toggle');styledSettings.clear();
        if (mounted) { mounted.nav.removeEventListener('click', mounted.navClick, true);mounted.item.remove();mounted.root.remove();mounted.viewBar.remove(); }
        mounted = null;signature = '';selected = null;opened = false;
    }
    function mount(sidebar, nav) {
        const item = node('li', null, 'nav-item');item.setAttribute('data-pz-plugin-manager', '');
        // 原生页签是链接；沿用链接颜色，避免 button 默认黑字。
        const tab = node('a', '插件', 'nav-link');tab.href = '#';tab.setAttribute('role', 'tab');tab.setAttribute('aria-selected', 'false');
        tab.addEventListener('click', event => { event.preventDefault();show(); });item.append(tab);
        const root = node('section', null, 'pz-plugin-manager');root.setAttribute('data-pz-plugin-manager', '');root.hidden = true;
        const toolbar = node('div', null, 'pz-plugin-toolbar'), selector = node('select');
        for (const [value, label] of [['project', `项目 ${context().projectId}`], ['global', '全局设置']]) { const option = node('option', label);option.value = value;selector.append(option); }
        selector.value = scope;selector.addEventListener('change', () => { scope = selector.value;signature = '';queue(); });
        const checkAll = button('检查更新', () => { for (const entry of entries()) checkUpdate(entry); });
        toolbar.append(selector, checkAll);
        const message = node('p', '', 'pz-plugin-status'), list = node('div', null, 'pz-plugin-list');root.append(toolbar, message, list);
        const viewBar = node('div', null, 'pz-plugin-view-bar');viewBar.setAttribute('data-pz-plugin-manager', '');viewBar.hidden = true;
        const back = iconButton('back', '返回插件列表', event => { event.preventDefault();event.stopPropagation();show(); }, 'pz-plugin-back');
        const viewTitle = node('span', '', 'pz-plugin-view-title');viewBar.append(back, node('span', '插件', 'text-muted'), node('span', '/', 'text-muted'), viewTitle);
        const navClick = event => {
            const link = event.target?.closest?.('.nav-link,[role="tab"]');
            if (opened && !activating && link && link !== tab && nav.contains(link)) close();
        };
        nav.addEventListener('click', navClick, true);nav.append(item);nav.after(viewBar, root);
        mounted = { sidebar, nav, item, tab, root, list, status: message, navClick, selector, checkAll, viewBar, viewTitle };
        if (!doc.getElementById('pz-plugin-manager-style')) {
            const style = node('style');style.id = 'pz-plugin-manager-style';style.textContent =
                '[data-pz-plugin-collected],[data-pz-plugin-masked]{display:none!important}' +
                '.pz-plugin-manager[hidden],.pz-plugin-view-bar[hidden],.pz-plugin-details[hidden]{display:none!important}' +
                '.pz-plugin-manager:not([hidden]){display:block!important}.pz-plugin-view-bar:not([hidden]){display:flex!important}' +
                '[data-pz-plugin-manager]>.nav-link{width:100%;border:0;cursor:pointer;color:#007bff;background:transparent}' +
                '[data-pz-plugin-manager]>.nav-link.active{color:#fff;background:#007bff}' +
                '.pz-plugin-toolbar [hidden]{display:none!important}' +
                '.pz-plugin-manager{margin-top:10px;color:inherit;font-size:.875rem}.pz-plugin-toolbar,.pz-plugin-actions,.pz-plugin-rules,.pz-plugin-extra-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px}' +
                '.pz-plugin-toolbar{margin-bottom:8px;justify-content:space-between}.pz-plugin-toolbar select{max-width:100%;padding:5px 8px;border:1px solid #adb5bd66;border-radius:6px;background:transparent;color:inherit;font:inherit}' +
                '.pz-plugin-card{padding:12px 14px;margin:0;border-bottom:1px solid #adb5bd40}.pz-plugin-card:last-child{border-bottom:0}.pz-plugin-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:32px}' +
                '.pz-plugin-identity{display:flex;align-items:baseline;flex-wrap:wrap;gap:8px;min-width:0}.pz-plugin-identity strong{font-size:1rem;font-weight:600;overflow-wrap:anywhere}.pz-plugin-identity span{font-size:.75rem}' +
                '.pz-plugin-actions{flex-wrap:nowrap;flex-shrink:0;gap:6px}.pz-plugin-open{border:1px solid #007bff;border-radius:6px;padding:4px 12px;color:#007bff;background:transparent;font:inherit;line-height:1.5;cursor:pointer}' +
                '.pz-plugin-open:hover{color:#fff;background:#007bff}.pz-plugin-disclosure,.pz-plugin-back{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:5px;border:0;border-radius:6px;background:transparent;color:#6c757d;cursor:pointer}' +
                '.pz-plugin-disclosure:hover,.pz-plugin-back:hover{background:#007bff10;color:#007bff}.pz-plugin-disclosure svg,.pz-plugin-back svg{width:20px;height:20px;flex-shrink:0}.pz-plugin-disclosure[aria-expanded=true] svg{transform:rotate(180deg)}' +
                '.pz-plugin-details{margin-top:12px;padding-top:12px;border-top:1px solid #adb5bd30}.pz-plugin-extra-actions{margin-bottom:12px}.pz-plugin-extra-actions .btn{font-size:.8125rem;padding:3px 8px;border:0}.pz-plugin-extra-actions a{font-size:.8125rem}' +
                '.pz-plugin-rules{align-items:flex-start;gap:8px 18px}.pz-plugin-rules label{margin:0;display:inline-flex;align-items:center;gap:5px}.pz-plugin-note,.pz-plugin-update,.pz-plugin-status{font-size:.8125rem;margin:6px 0}.pz-plugin-status:empty{display:none}.pz-plugin-fields{display:grid;gap:8px;margin-top:12px}' +
                '.pz-plugin-fields label{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0}.pz-plugin-fields input:not([type=checkbox]),.pz-plugin-fields select{max-width:55%;border:1px solid #adb5bd66;border-radius:5px;padding:4px 6px;background:transparent;color:inherit;font:inherit}' +
                '.pz-plugin-view-bar{align-items:center;gap:8px;margin:8px 0;padding:5px 0;font-size:.8125rem;flex-shrink:0}.pz-plugin-view-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
                '[data-pz-plugin-panel] .pz-plugin-settings-toggle{display:inline-flex!important;align-items:center;justify-content:center;width:28px!important;height:28px!important;font-size:0!important;border:0!important}' +
                '[data-pz-plugin-panel] .pz-plugin-settings-toggle>*{display:none!important}[data-pz-plugin-panel] .pz-plugin-settings-toggle:after{content:"";width:8px;height:8px;border-right:1.8px solid currentColor;border-bottom:1.8px solid currentColor;transform:rotate(45deg);margin-top:-4px}' +
                '[data-pz-plugin-panel] .pz-plugin-settings-toggle[aria-expanded=true]:after{transform:rotate(225deg);margin-top:4px}' +
                '[data-pz-plugin-panel] .pt-settings-groups{align-items:start!important;gap:10px!important;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr))!important}' +
                '[data-pz-plugin-panel] .pt-settings-controls{display:grid!important;grid-template-columns:1fr!important;gap:8px!important}[data-pz-plugin-panel] .pt-settings label{display:flex!important;width:100%;gap:8px!important;font-size:.8125rem!important}' +
                '[data-pz-plugin-panel] .pt-settings label input:not([type=checkbox]),[data-pz-plugin-panel] .pt-settings label select{margin-left:auto!important}[data-pz-plugin-panel] .pt-settings input[type=number]{width:70px!important}' +
                '[data-pz-plugin-panel] .pt-settings-group{padding:10px!important;border-radius:6px!important}[data-pz-plugin-panel] .pt-settings-title{font-size:.8125rem!important}[data-pz-plugin-panel] .pt-settings-group-footer{margin-top:8px!important}' +
                '[data-pz-plugin-panel] .pt-settings{max-height:min(46dvh,420px)!important}[data-pz-plugin-panel] .pt-settings-actions{margin-top:10px!important;font-size:.8125rem!important}';
            doc.head?.append(style);
        }
    }
    function sync() {
        const ctx = context(), key = `${ctx.userId}:${ctx.projectId}`;
        if (key !== currentContext) { close();scope = 'project';currentContext = key;signature = ''; }
        const sidebar = ctx.projectId && doc.querySelector('.sidebar-right');
        const nav = sidebar && [...(sidebar.children || [])].find(element => element.classList.contains('nav') &&
            [...element.querySelectorAll('.nav-link')].some(link => nativeLabel.test(link.textContent.trim())));
        let previousView = null;
        if (mounted && (!mounted.item.isConnected || !mounted.root.isConnected || !mounted.viewBar.isConnected || mounted.nav !== nav)) {
            previousView = { opened, selected };teardown();
        }
        if (!nav) return;
        if (!mounted) mount(sidebar, nav);
        if (previousView) { opened = previousView.opened;selected = previousView.selected; }
        if (mounted.selector.value !== scope) mounted.selector.value = scope;
        const projectOption = mounted.selector.children[0];
        if (projectOption.textContent !== `项目 ${ctx.projectId}`) projectOption.textContent = `项目 ${ctx.projectId}`;
        const list = entries(), nextSources = new Set();
        for (const entry of list) {
            // 旧校对脚本会再延迟调用一次 show；返回列表时不能让这次回调把面板重新打开。
            if (opened && !selected && entry.controller?.isVisible?.()) entry.controller.hide?.();
            if (entry.panel?.isConnected) {
                if (!styledPanels.has(entry.panel)) { entry.panel.setAttribute('data-pz-plugin-panel', '');styledPanels.add(entry.panel); }
                const settings = entry.panel.querySelector('.pt-head [data-action="settings"]');
                if (settings && !styledSettings.has(settings)) { settings.classList.add('pz-plugin-settings-toggle');styledSettings.add(settings); }
            }
            const previousUpdate = updates.get(entry.id);
            if (previousUpdate && previousUpdate.metadataKey !== JSON.stringify([entry.version, safeURL(entry.updateURL), entry.metadataName])) updates.delete(entry.id);
            if (entry.item && rule(entry.id).collect) nextSources.add(entry.item);
            if (entry.client) {
                const state = JSON.stringify(effective(entry));
                if (entry.client.applied !== state && !entry.client.applying && entry.client.failed !== state)
                    apply(entry).catch(error => status(error?.message || '插件设置未能应用'));
            }
        }
        for (const item of sourceItems) if (!nextSources.has(item)) item.removeAttribute('data-pz-plugin-collected');
        for (const item of nextSources) if (!sourceItems.has(item)) item.setAttribute('data-pz-plugin-collected', '');
        sourceItems.clear();for (const item of nextSources) sourceItems.add(item);
        mounted.root.hidden = !opened || !!selected;
        mounted.viewBar.hidden = !opened || !selected;
        if (!mounted.root.hidden) mounted.root.style.removeProperty('display');
        if (!mounted.viewBar.hidden) mounted.viewBar.style.removeProperty('display');
        if (opened) {
            if (selected && !list.some(entry => entry.id === selected)) { selected = null;signature = '';mounted.root.hidden = false;mounted.viewBar.hidden = true; }
            if (selected) {
                const title = list.find(entry => entry.id === selected)?.title || '';
                if (mounted.viewTitle.textContent !== title) mounted.viewTitle.textContent = title;
            }
            mounted.checkAll.hidden = !list.some(entry => safeURL(entry.updateURL) && entry.version);
            mounted.tab.classList.add('active');
            if (mounted.tab.getAttribute('aria-selected') !== 'true') mounted.tab.setAttribute('aria-selected', 'true');
            hideNativeActive();mask();
            for (const entry of list) if (safeURL(entry.updateURL) && entry.version && !updates.has(entry.id)) checkUpdate(entry);
            const count = list.filter(entry => updates.get(entry.id)?.available).length;
            const label = count ? `插件 · ${count}` : '插件';if (mounted.tab.textContent !== label) mounted.tab.textContent = label;
            // 打开插件后只显示原插件面板；再次点“插件”页签即返回列表。
            if (selected) return;
            const view = list;
            const next = JSON.stringify([scope, selected, view.map(entry => [entry.id, entry.title, entry.version, expanded.has(entry.id), rule(entry.id), entry.client?.failed, updates.get(entry.id)])]);
            const editingField = mounted.list.contains(doc.activeElement) && doc.activeElement?.closest?.('.pz-plugin-fields');
            if (signature !== next && !editingField) {
                signature = next;mounted.list.replaceChildren(...view.map(renderCard));
                if (!view.length) mounted.list.append(node('p', '当前页面还没有检测到插件入口。'));
            }
        }
    }
    // 其他脚本可通过 register 接入。setEnabled 负责真正启停，applyConfig 接收当前项目设置。
    // 没有接入的脚本仍可自动收纳入口，但不会被冒充为支持启停或独立配置。
    // 先检查 window.ParaTranzPluginManager；若尚未加载，监听 paratranz-tools:plugins-ready。
    const api = {
        owner: 'ParaTranz-tools', version: '1.6.2', sync,
        register(descriptor) {
            if (!descriptor || !validId(descriptor.id) || !descriptor.title || /^ParaTranz-tools$/i.test(descriptor.title)) throw new Error('插件信息不完整');
            if (clients.get(descriptor.id)?.version !== descriptor.version) updates.delete(descriptor.id);
            const client = { ...descriptor, applied: '', applying: '', failed: '' };clients.set(client.id, client);signature = '';queue();
            return () => { if (clients.get(client.id) === client) { clients.delete(client.id);signature = '';queue(); } };
        },
        isEnabled(id, projectId) { return validId(id) && rule(id, String(projectId || context().projectId)).enabled; },
        getConfig(id) { return validId(id) ? clone(rule(id).config) : {}; },
        list() { return entries().map(entry => ({ id: entry.id, title: entry.title, version: entry.version || '',
            canControl: typeof entry.setEnabled === 'function', canConfigure: typeof entry.applyConfig === 'function', ...rule(entry.id) })); },
        open: show,
        destroy() { teardown();observer?.disconnect();doc.removeEventListener('focusout', queue);if (page.ParaTranzPluginManager === api) delete page.ParaTranzPluginManager; },
        compareVersions
    };
    page.ParaTranzPluginManager = api;
    if (page.CustomEvent && page.dispatchEvent) page.dispatchEvent(new page.CustomEvent('paratranz-tools:plugins-ready', { detail: api }));
    function start() {
        observer = new page.MutationObserver(queue);observer.observe(doc.body, { childList: true, subtree: true });
        // 页面切换由主脚本已有的轮询调用 sync；不再另开定时器。
        doc.addEventListener('focusout', queue);sync();
    }
    if (doc.body) start();else doc.addEventListener('DOMContentLoaded', start, { once: true });
})();

// ===== 功能：用项目讨论中的标记共享疑问分组 =====
(() => {
    'use strict';
    const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const MARK = '[ParaTranz-tools:dispute-groups:v1]', TITLE = '疑问分组 · ParaTranz-tools', sessions = new Map();
    const key = ctx => `${ctx.userId}:${ctx.projectId}`;
    const positive = value => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
    const validId = value => typeof value === 'string' && /^[\w-]{1,100}$/.test(value);
    const validName = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 50;
    const unwrap = value => value?.data && !value.results && !value.id ? value.data : value;
    function session(ctx) { if (!sessions.has(key(ctx))) sessions.set(key(ctx), { known: false, roots: [], managers: new Set(), value: null, pending: null, tail: Promise.resolve() });return sessions.get(key(ctx)); }
    function encode(operation) { return `${MARK}\n\n\`\`\`json\n${JSON.stringify(operation)}\n\`\`\``; }
    function decode(content) {
        if (typeof content !== 'string' || content.length > 1000000 || !content.startsWith(MARK + '\n')) return null;
        const match = /^\[ParaTranz-tools:dispute-groups:v1\]\s+```json\s*([\s\S]*?)\s*```\s*$/.exec(content);
        if (!match) return null;try { const value = JSON.parse(match[1]);return value?.v === 1 && validId(value.opId) ? value : null; } catch { return null; }
    }
    function reduce(roots, managers = new Set()) {
        const value = { groups: [], assignments: Object.create(null) }, seen = new Set(), aliases = new Map();
        const resolve = id => { for (let n = 0; aliases.has(id) && n < 100; n++) id = aliases.get(id);return id; };
        const add = (group, author) => {
            if (!validId(group?.id) || !validName(group.name)) return;
            const old = value.groups.find(item => item.id === resolve(group.id) || item.name === group.name);
            if (old) { if (old.id !== group.id) aliases.set(group.id, old.id);return; }value.groups.push({ id: group.id, name: group.name, createdBy: author });
        };
        const apply = (operation, author) => {
            if (!operation || !positive(author) || seen.has(operation.opId)) return;
            author = String(author);
            if (['rename', 'delete'].includes(operation.kind)) {
                const group = value.groups.find(item => item.id === resolve(operation.groupId));
                if (!group || group.createdBy !== author && !managers.has(author)) return;
            }
            seen.add(operation.opId);
            if (operation.kind === 'init') {
                for (const group of (Array.isArray(operation.groups) ? operation.groups : [])) add(group, author);
                for (const [id, group] of Object.entries(operation.assignments || {})) if (positive(id) && value.groups.some(item => item.id === resolve(group))) value.assignments[id] = resolve(group);
            } else if (operation.kind === 'create') add(operation.group, author);
            else if (operation.kind === 'rename' && validName(operation.name)) {
                const group = value.groups.find(item => item.id === resolve(operation.groupId));if (!group) return;
                const duplicate = value.groups.find(item => item.id !== group.id && item.name === operation.name);
                if (duplicate) {
                    aliases.set(group.id, duplicate.id);value.groups = value.groups.filter(item => item !== group);
                    for (const id of Object.keys(value.assignments)) if (value.assignments[id] === group.id) value.assignments[id] = duplicate.id;
                } else group.name = operation.name;
            } else if (operation.kind === 'delete') {
                const groupId = resolve(operation.groupId);value.groups = value.groups.filter(item => item.id !== groupId);
                for (const id of Object.keys(value.assignments)) if (value.assignments[id] === groupId) delete value.assignments[id];
            } else if (operation.kind === 'assign' && positive(operation.stringId)) {
                const groupId = resolve(operation.groupId);
                if (groupId === '') delete value.assignments[String(operation.stringId)];
                else if (value.groups.some(item => item.id === groupId)) value.assignments[String(operation.stringId)] = groupId;
            }
        };
        const activities = [];
        for (const root of roots.slice().sort((a, b) => Number(a.id) - Number(b.id))) {
            apply(decode(root.content), root.lastEdit || root.uid);
            for (const activity of root.activities || []) {
                const operation = decode(activity.content);if (operation) activities.push({ operation, author: activity.lastEdit || activity.uid, id: Number(activity.id) || 0, time: Date.parse(activity.createdAt) || 0 });
            }
        }
        activities.sort((a, b) => a.time - b.time || a.id - b.id || a.operation.opId.localeCompare(b.operation.opId));
        for (const activity of activities) apply(activity.operation, activity.author);return { value, seen };
    }
    async function readManagers(ctx) {
        const [project, members] = await Promise.all([
            ctx.vm.$req.get(`/projects/${ctx.projectId}`, { silent: true }).then(unwrap),
            ctx.vm.$req.get(`/projects/${ctx.projectId}/members`, { silent: true }).then(unwrap)
        ]);
        if (Number(project?.id) !== Number(ctx.projectId) || !positive(project.uid) || !Array.isArray(members)) throw new Error('无法确认项目管理权限，请刷新重试');
        const managers = new Set([String(project.uid)]);
        for (const member of members) if (positive(member.uid) && Number(member.project) === Number(ctx.projectId) && [3, 10].includes(Number(member.permission))) managers.add(String(member.uid));
        return managers;
    }
    async function discover(ctx, refresh = false) {
        const current = session(ctx);
        if (current.pending) return current.pending;
        if (current.known && !refresh) return current.value;
        if (!ctx.projectId || !ctx.userId || !ctx.vm?.$req?.get) return null;
        current.pending = (async () => {
            const candidates = new Map();
            // 已关闭的存储讨论也能读取；不自动创建、重开或订阅讨论。
            for (const status of [0, 1]) {
                let pages = 1;const fetched = new Set();
                for (let index = 1; index <= pages; index++) {
                    const result = unwrap(await ctx.vm.$req.get(`/projects/${ctx.projectId}/issues`, { params: { status, page: index, pageSize: 100 }, silent: true }));
                    if (!Array.isArray(result?.results)) throw new Error('项目分组读取失败：讨论列表格式不正确');
                    pages = Number(result.pageCount || Math.ceil(Number(result.rowCount || 0) / (Number(result.pageSize) || 100)) || 1);
                    if (!Number.isSafeInteger(pages) || pages < 1 || pages > 1000) throw new Error('项目分组读取失败：讨论页数不正确');
                    let added = 0;
                    for (const issue of result.results) if (positive(issue.id) && !fetched.has(Number(issue.id))) {
                        fetched.add(Number(issue.id));added++;
                        if (issue.title === TITLE || decode(issue.content)?.kind === 'init') candidates.set(Number(issue.id), issue);
                    }
                    if (!added && (index < pages || index > 1 && result.results.length)) throw new Error('项目分组读取失败：讨论分页没有前进');
                }
            }
            const roots = [];
            for (const candidate of candidates.values()) {
                const issue = unwrap(await ctx.vm.$req.get(`/projects/${ctx.projectId}/issues/${candidate.id}`, { silent: true }));
                if (Number(issue?.id) !== Number(candidate.id)) throw new Error('项目分组读取失败：讨论 ID 不符');
                if (decode(issue.content)?.kind === 'init') { if (!Array.isArray(issue.activities)) throw new Error('项目分组读取失败：缺少变更记录');roots.push(issue); }
            }
            const managers = roots.length ? await readManagers(ctx) : new Set();
            current.roots = roots;current.managers = managers;current.value = roots.length ? reduce(roots, managers).value : null;current.known = true;return current.value;
        })().finally(() => { current.pending = null; });
        return current.pending;
    }
    function validate(operation, value, ctx) {
        if (operation.kind === 'create') {
            if (!validId(operation.group?.id) || !validName(operation.group.name)) throw new Error('分组名不正确');
            if (value.groups.some(group => group.name === operation.group.name)) throw new Error('已经有同名分组');
        } else if (operation.kind === 'assign') {
            if (!positive(operation.stringId)) throw new Error('词条尚未加载');
            if (operation.groupId && !value.groups.some(group => group.id === operation.groupId)) throw new Error('这个分组已不存在');
        } else if (operation.kind === 'rename' || operation.kind === 'delete') {
            const group = value.groups.find(group => group.id === operation.groupId);if (!group) throw new Error('这个分组已不存在');
            if (group.createdBy !== String(ctx.userId) && !session(ctx).managers.has(String(ctx.userId))) throw new Error('只能修改或删除自己创建的分组');
            if (operation.kind === 'rename' && (!validName(operation.name) || value.groups.some(group => group.id !== operation.groupId && group.name === operation.name))) throw new Error('分组名为空、过长或已经存在');
        } else throw new Error('分组操作不正确');
    }
    function token() { return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`; }
    function serialized(ctx, action) {
        const current = session(ctx), task = current.tail.then(action);current.tail = task.catch(() => {});return task;
    }
    function write(ctx, fields) {
        const operation = { ...fields, v: 1, opId: token() };
        return serialized(ctx, async () => {
            const value = await discover(ctx, true), current = session(ctx);
            if (!value) throw new Error('项目共享分组已不存在，请刷新后重试');validate(operation, value, ctx);
            const root = current.roots.slice().sort((a, b) => Number(a.id) - Number(b.id))[0];
            let reply;
            try {
                reply = unwrap(await ctx.vm.$req.post(`/projects/${ctx.projectId}/issues/${root.id}`, { op: 'reply', content: encode(operation) }));
                if (!positive(reply?.id) || String(reply.uid) !== String(ctx.userId) || decode(reply.content)?.opId !== operation.opId) throw new Error('分组保存响应不完整');
            } catch (error) {
                // 响应丢失时只读回核实，不重复提交同一操作。
                try { await discover(ctx, true);if (reduce(current.roots, current.managers).seen.has(operation.opId)) return current.value; } catch { /* 原始失败信息仍有效 */ }
                throw new Error(`共享分组未能保存：${error.message}`);
            }
            root.activities.push(reply);current.value = reduce(current.roots, current.managers).value;return current.value;
        });
    }
    function enable(ctx, local) {
        return serialized(ctx, async () => {
            if (await discover(ctx, true)) return session(ctx).value;
            const init = { v: 1, opId: token(), kind: 'init', groups: local.groups, assignments: local.assignments };
            const content = encode(init);
            const issue = unwrap(await ctx.vm.$req.post(`/projects/${ctx.projectId}/issues`, { title: TITLE, content }));
            if (!positive(issue?.id) || String(issue.uid) !== String(ctx.userId) || decode(issue.content)?.opId !== init.opId) throw new Error('共享分组创建响应不完整，请刷新检查项目讨论后再试');
            const current = session(ctx);current.roots = [{ ...issue, activities: Array.isArray(issue.activities) ? issue.activities : [] }];current.value = reduce(current.roots, current.managers).value;current.known = true;
            // 同时启用产生的多个存储讨论会在刷新时合并，统一向 ID 最小的一条追加。
            return current.value;
        });
    }
    page.ParaTranzDisputeGroupSharing = {
        version: '1.8.2', discover, enable, write,
        canManage(ctx, groupId) { const current = session(ctx), group = current.value?.groups.find(group => group.id === groupId);return !!group && (group.createdBy === String(ctx.userId) || current.managers.has(String(ctx.userId))); },
        known(ctx) { return session(ctx).known; },
        value(ctx) { return session(ctx).value; },
        issueId(ctx) { const roots = session(ctx).roots;return roots.length ? Math.min(...roots.map(root => Number(root.id))) : 0; }
    };
})();

// ===== 功能：手动创建疑问分组、标记时分组、按组查看 =====
(() => {
    'use strict';
    const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window, doc = page.document;
    const KEY = 'paratranz-tools.dispute-groups.v1', bindings = new Map(), nativeLists = new Map();
    let data = {}, mounted = null, contextKey = '', overviewOpen = false, filter = 'all', listPage = 1, rows = [], loaded = false, loading = false, request = 0, signature = '', queued = false, serial = 0, destroyed = false;
    const PAGE_SIZE = 10, sharing = page.ParaTranzDisputeGroupSharing;
    try { data = JSON.parse(page.localStorage.getItem(KEY)) || {}; } catch { /* 首次使用 */ }
    if (typeof data !== 'object' || Array.isArray(data)) data = {};
    const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
    const copy = value => JSON.parse(JSON.stringify(value));
    const positive = value => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
    function findVM(selector, match) {
        let vm = doc.querySelector(selector)?.__vue__;
        for (let i = 0; vm && i < 16; i++, vm = vm.$parent) if (match(vm)) return vm;
        return null;
    }
    function context() {
        const route = /^\/projects\/(\d+)\/(strings|issues|settings)(?:\/.*)?$/.exec(page.location.pathname);
        const vm = findVM('.string-editor', vm => vm.$uid && vm.$req) || findVM('.issues,.strings,.settings', vm => vm.$uid && vm.$req);
        return { projectId: route?.[1] || '', route: route?.[2] || '', userId: positive(vm?.$uid) ? String(vm.$uid) : '', vm };
    }
    function editor() { return findVM('.string-editor', vm => vm.$options?.name === 'stringEditor' && vm.item && typeof vm.markAs === 'function'); }
    function listVM() {
        const match = vm => vm.$options?.name === 'strings' && vm.$route && typeof vm.fetchStrings === 'function';
        return findVM('.strings', match) || findVM('.string-editor', match);
    }
    function localState(ctx = context()) {
        if (!ctx.projectId || !ctx.userId) return { groups: [], assignments: {} };
        const user = own(data, ctx.userId) ? data[ctx.userId] : (data[ctx.userId] = {});
        if (!own(user, ctx.projectId) || !Array.isArray(user[ctx.projectId]?.groups) || !user[ctx.projectId]?.assignments) user[ctx.projectId] = { groups: [], assignments: {} };
        for (const group of user[ctx.projectId].groups) if (!positive(group.createdBy)) group.createdBy = ctx.userId;
        return user[ctx.projectId];
    }
    function state(ctx = context()) { return sharing?.value(ctx) || localState(ctx); }
    function canManageGroup(groupId, ctx = context()) {
        if (sharing?.value(ctx)) return sharing.canManage(ctx, groupId);
        const group = localState(ctx).groups.find(group => group.id === groupId), permission = Number(ctx.vm?.$store?.state?.permissions?.[ctx.projectId]);
        return !!group && (group.createdBy === ctx.userId || [3, 10].includes(permission));
    }
    function ready(ctx, action) { return sharing && !sharing.known(ctx) ? sharing.discover(ctx).then(action) : action(); }
    async function refreshShared(ctx = context()) { if (sharing) await sharing.discover(ctx, true);signature = '';queue(); }
    async function sharedWrite(ctx, operation) { await sharing.write(ctx, operation);signature = '';queue(); }
    function change(fn, ctx = context()) {
        if (!ctx.projectId || !ctx.userId) throw new Error('请等待账号和项目加载完成');
        // 先读取其他标签页刚保存的分组，避免用旧副本覆盖它。
        const latest = page.localStorage.getItem(KEY);
        if (latest) { const parsed = JSON.parse(latest);if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed; }
        const previous = copy(data);
        try { const result = fn(localState(ctx));page.localStorage.setItem(KEY, JSON.stringify(data));signature = '';queue();return result; }
        catch (error) { data = previous;throw error; }
    }
    function groupName(value) {
        const name = String(value ?? '').trim();
        if (!name) throw new Error('请输入分组名');
        if (name.length > 50) throw new Error('分组名最多 50 个字');
        return name;
    }
    function createGroup(value, ctx = context()) {
        const name = groupName(value);
        const id = `g${Date.now().toString(36)}-${(++serial).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        return ready(ctx, () => {
            if (sharing?.value(ctx)) return sharedWrite(ctx, { kind: 'create', group: { id, name } }).then(() => state(ctx).groups.find(group => group.id === id || group.name === name).id);
            return change(value => { if (value.groups.some(group => group.name === name)) throw new Error('已经有同名分组');value.groups.push({ id, name, createdBy: ctx.userId });return id; }, ctx);
        });
    }
    function assign(id, groupId, ctx = context()) {
        if (!positive(id)) throw new Error('词条尚未加载');
        return ready(ctx, () => {
            if (sharing?.value(ctx)) return sharedWrite(ctx, { kind: 'assign', stringId: Number(id), groupId: groupId || '' });
            return change(value => { if (groupId && !value.groups.some(group => group.id === groupId)) throw new Error('这个分组已不存在');if (groupId) value.assignments[String(id)] = groupId;else delete value.assignments[String(id)]; }, ctx);
        });
    }
    function renameGroup(groupId, name, ctx = context()) {
        name = groupName(name);
        return ready(ctx, () => sharing?.value(ctx) ? sharedWrite(ctx, { kind: 'rename', groupId, name }) : change(value => {
            const group = value.groups.find(group => group.id === groupId);if (!group) throw new Error('这个分组已不存在');
            if (!canManageGroup(groupId, ctx)) throw new Error('只能修改或删除自己创建的分组');
            if (value.groups.some(group => group.id !== groupId && group.name === name)) throw new Error('已经有同名分组');group.name = name;
        }, ctx));
    }
    function removeGroup(groupId, ctx = context()) {
        return ready(ctx, () => sharing?.value(ctx) ? sharedWrite(ctx, { kind: 'delete', groupId }) : change(value => {
            if (!canManageGroup(groupId, ctx)) throw new Error('只能修改或删除自己创建的分组');
            value.groups = value.groups.filter(group => group.id !== groupId);
            for (const id of Object.keys(value.assignments)) if (value.assignments[id] === groupId) delete value.assignments[id];
        }, ctx));
    }
    function node(tag, text, className) { const element = doc.createElement(tag);if (text != null) element.textContent = text;if (className) element.className = className;return element; }
    function button(text, action, className = 'pz-dg-button') {
        const element = node('button', text, className);element.type = 'button';
        element.addEventListener('click', event => { event.preventDefault();event.stopPropagation();try { const pending = action(event);pending?.catch?.(report); } catch (error) { report(error); } });return element;
    }
    function report(error) {
        const message = error?.message || '操作失败，请重试';
        if (mounted) mounted.status.textContent = message;
        for (const binding of bindings.values()) {
            const container = binding.promptUI?.isConnected ? binding.promptUI : binding.popup && !binding.popup.hidden ? binding.popup : binding.bar;
            if (container) { let status = container.querySelector('.pz-dg-status');if (!status) { status = node('p', '', 'pz-dg-status');container.append(status); }status.textContent = message; }
        }
    }
    function queue() { if (queued || destroyed) return;queued = true;page.requestAnimationFrame(() => { queued = false;if (!destroyed) sync(); }); }
    function selectGroup(selected, handler, ctx = context()) {
        const select = node('select');select.setAttribute('aria-label', '疑问分组');
        const none = node('option', '未分组');none.value = '';select.append(none);
        for (const group of state(ctx).groups) { const option = node('option', group.name);option.value = group.id;select.append(option); }
        select.value = state(ctx).groups.some(group => group.id === selected) ? selected : '';
        select.addEventListener('change', () => { try { handler(select.value)?.catch?.(report); } catch (error) { report(error); } });return select;
    }
    function groupPicker(selected, handler, ctx = context()) {
        const wrap = node('div', null, 'pz-dg-picker'), select = selectGroup(selected, value => {
            if (value === '+new') { create.hidden = false;create.querySelector('input')?.focus();return; }
            create.hidden = true;return handler(value);
        }, ctx);
        const option = node('option', '+ 新建分组…');option.value = '+new';select.append(option);
        const create = newGroupForm(async id => {
            select.querySelector('[value="+new"]').before(Object.assign(node('option', state(ctx).groups.find(group => group.id === id)?.name || ''), { value: id }));
            select.value = id;create.hidden = true;await handler(id);
        }, ctx);create.hidden = true;wrap.append(select, create);return wrap;
    }
    function newGroupForm(action, ctx = context()) {
        const form = node('form', null, 'pz-dg-create'), input = node('input');input.type = 'text';input.placeholder = '手动输入新分组名';input.maxLength = 50;input.setAttribute('aria-label', '新分组名');
        const submit = node('button', '创建', 'pz-dg-button');submit.type = 'submit';form.append(input, submit);
        form.addEventListener('submit', event => {
            event.preventDefault();event.stopPropagation();if (submit.disabled) return;submit.disabled = true;
            form.saveTask = (async () => {
                try { const id = await createGroup(input.value, ctx);await action(id);input.value = '';input.blur();queue(); }
                finally { submit.disabled = false; }
            })();form.saveTask.catch(report);
        });
        return form;
    }
    // ---- 仅在原生保存确实成功后记录分类 ----
    function bind(vm) {
        if (bindings.has(vm)) return bindings.get(vm);
        const original = vm.markAs, ctx = context(), binding = { vm, original, ctx, busy: false, choice: undefined, popup: null, arrow: null, target: null, bar: null };
        binding.saved = result => {
            if (!result || !positive(result.id) || result.stage == null) return;
            try {
                if (binding.pending && Number(result.id) === binding.pending.id && Number(result.stage) === 2) {
                    binding.pending.committed = true;
                    if (binding.pending.group || binding.pending.explicit || own(state(binding.pending.ctx).assignments, String(result.id))) binding.pending.saveTask = Promise.resolve(assign(result.id, binding.pending.group, binding.pending.ctx)).catch(error => report(new Error(`词条已保存，但分组未能保存：${error.message}`)));
                } else if (Number(result.stage) !== 2 && own(state(binding.ctx).assignments, String(result.id))) Promise.resolve(assign(result.id, '', binding.ctx)).catch(error => report(new Error(`分组未能保存：${error.message}`)));
            } catch (error) { report(new Error(`词条已保存，但分组未能保存：${error.message}`)); }
        };
        binding.wrapper = async function(stage, ...args) {
            if (Number(stage) !== 2) return original.call(this, stage, ...args);
            if (binding.busy || this.saving || this.canEdit === false || this.canDispute === false || !positive(this.item?.id)) return;
            const id = Number(this.item.id), ctx = context();
            const explicit = binding.choice !== undefined, group = explicit ? binding.choice : state(ctx).assignments[String(id)] || '';
            binding.choice = undefined;binding.busy = true;binding.pending = { id, ctx, group, explicit, committed: false };
            const descriptor = Object.getOwnPropertyDescriptor(this, '$dialog'), dialog = this.$dialog;
            const proxy = dialog && Object.create(dialog);
            if (proxy && typeof dialog.prompt === 'function') proxy.prompt = async options => {
                const anchor = `pz-dg-prompt-${++serial}`;
                binding.promptAnchor = anchor;
                try {
                    const result = await dialog.prompt.call(dialog, {
                        ...options, content: `${options.content || ''}<span id="${anchor}" class="pz-dg-prompt"></span>`,
                        validate: text => {
                            const form = binding.promptUI?.querySelector('form');
                            if (form && !form.hidden) { report(new Error('请先创建分组，或选择已有分组'));return false; }
                            return typeof options.validate === 'function' ? options.validate(text) : true;
                        }
                    });
                    if (result !== null) await binding.promptUI?.querySelector('form')?.saveTask;
                    return result;
                }
                finally { binding.promptUI?.remove();binding.promptUI = null;binding.promptAnchor = ''; }
            };
            try {
                await ready(ctx, () => undefined);
                if (Number(this.item?.id) !== id || this.canEdit === false || this.canDispute === false) return;
                if (!explicit) binding.pending.group = state(ctx).assignments[String(id)] || '';
                if (proxy) this.$dialog = proxy;
                const result = await original.call(this, stage, ...args);await binding.pending?.saveTask;return result;
            } finally {
                if (this.$dialog === proxy) { if (descriptor) Object.defineProperty(this, '$dialog', descriptor);else delete this.$dialog; }
                binding.promptUI?.remove();binding.promptUI = null;binding.promptAnchor = '';binding.pending = null;binding.busy = false;queue();
            }
        };
        vm.markAs = binding.wrapper;vm.$on?.('save', binding.saved);
        vm.$once?.('hook:beforeDestroy', () => unbind(binding));bindings.set(vm, binding);return binding;
    }
    function clearUI(binding) {
        binding.arrow?.remove();binding.popup?.remove();binding.bar?.remove();binding.target?.parentElement?.classList.remove('pz-dg-menu-row');binding.target?.classList.remove('pz-dg-target');
        binding.arrow = binding.popup = binding.bar = binding.target = null;
    }
    function unbind(binding) {
        clearUI(binding);if (binding.vm.markAs === binding.wrapper) binding.vm.markAs = binding.original;
        binding.vm.$off?.('save', binding.saved);bindings.delete(binding.vm);
    }
    async function mark(binding, id, group) {
        if (Number(binding.vm.item?.id) !== id) { report(new Error('词条已切换，请重新选择分组'));return; }
        if (binding.busy || binding.vm.saving || binding.vm.canEdit === false || binding.vm.canDispute === false) return;
        binding.choice = group;if (binding.popup) binding.popup.hidden = true;
        await binding.vm.markAs(2);
    }
    async function showChoices(binding, refresh = false) {
        if (!binding.popup) return;
        if (!binding.popup.hidden && !refresh) { binding.popup.hidden = true;return; }
        await ready(context(), () => undefined);
        if (!binding.popup?.isConnected || binding.busy) return;
        const id = Number(binding.vm.item.id), panel = binding.popup;
        binding.popupId = id;
        panel.replaceChildren(node('div', '标记疑问并分到', 'pz-dg-muted'));
        panel.append(button('未分组', () => mark(binding, id, '')));
        for (const group of state().groups) panel.append(button(group.name, () => mark(binding, id, group.id)));
        if (!state().groups.length) panel.append(node('small', '还没有分组，输入组名即可创建。', 'pz-dg-muted'));
        panel.append(newGroupForm(() => showChoices(binding, true)));panel.hidden = false;
    }
    function syncEditor(vm) {
        for (const [old, binding] of bindings) if (old !== vm || old._isDestroyed) unbind(binding);
        if (!vm || !context().userId) return;
        const binding = bind(vm), host = doc.querySelector('.string-editor');
        if (binding.promptAnchor) {
            const anchor = doc.getElementById(binding.promptAnchor);
            if (anchor && !binding.promptUI?.isConnected && binding.pending) {
                const pending = binding.pending, picker = groupPicker(pending.group, value => { pending.group = value;pending.explicit = true; }, pending.ctx);
                binding.promptUI = node('div', null, 'pz-dg-prompt-group');binding.promptUI.append(node('label', '选择分组'), picker);anchor.append(binding.promptUI);
            }
        }
        const target = [...(host?.querySelectorAll('.dropdown-item') || [])].find(element => /^(标记为有疑问|Mark as Disputed)$/.test(element.textContent.trim()));
        if (binding.target !== target || binding.arrow && !binding.arrow.isConnected) {
            clearUI(binding);
            if (target?.parentElement && target.closest('.dropdown-menu')) {
                binding.target = target;target.classList.add('pz-dg-target');
                binding.arrow = button('', () => showChoices(binding), 'pz-dg-arrow');binding.arrow.setAttribute('aria-label', '选择疑问分组');binding.arrow.title = '选择疑问分组';
                binding.popup = node('div', null, 'pz-dg-choices');binding.popup.hidden = true;
                const parent = target.parentElement;parent.classList.add('pz-dg-menu-row');parent.append(binding.arrow, binding.popup);
            }
        }
        if (binding.arrow) binding.arrow.disabled = binding.busy || vm.saving || vm.canEdit === false || vm.canDispute === false;
        if (binding.popup && binding.popupId !== Number(vm.item.id)) binding.popup.hidden = true;
        if (Number(vm.item.stage) === 2) {
            const stamp = JSON.stringify([vm.item.id, state().groups, state().assignments[String(vm.item.id)]]);
            if (!binding.bar?.isConnected || binding.barStamp !== stamp) {
                binding.bar?.remove();binding.bar = node('div', null, 'pz-dg-editor-group');binding.barStamp = stamp;
                const id = Number(vm.item.id), ctx = context();
                binding.bar.append(node('span', '疑问分组'), groupPicker(state(ctx).assignments[String(id)], value => {
                    if (Number(vm.item.id) !== id) throw new Error('词条已切换');return assign(id, value, ctx);
                }, ctx), button('管理分组', openOverview));host.append(binding.bar);
            }
        } else { binding.bar?.remove();binding.bar = null; }
    }
    // ---- 按组浏览仍使用网站左侧词条列表、页码和编辑器 ----
    function managed(query) {
        return String(query?.stage) === '2' && !query.id && (query.pzGroup != null || !Object.keys(query).some(key => !['stage', 'page', 'pageSize', 'anchor', 'ref', 'detailed'].includes(key)));
    }
    async function readDisputed(ctx) {
        const all = [], ids = new Set();let pageCount = 1, base;
        for (let index = 1; index <= pageCount; index++) {
            const response = await ctx.vm.$req.get(`/projects/${ctx.projectId}/strings`, { params: { stage: 2, page: index, pageSize: 800, detailed: 1 } });
            const value = response?.results ? response : response?.data;
            if (!Array.isArray(value?.results)) throw new Error('疑问列表返回格式不正确');base ||= value;
            const pages = Number(value.pageCount || Math.ceil(Number(value.rowCount || 0) / (Number(value.pageSize) || 800)) || 1);
            if (!Number.isSafeInteger(pages) || pages < 1 || pages > 1000) throw new Error('疑问列表页数不正确');pageCount = pages;
            let added = 0;
            for (const row of value.results) if (positive(row.id) && Number(row.stage) === 2 && !ids.has(Number(row.id))) { ids.add(Number(row.id));all.push(row);added++; }
            if (!added && (index < pageCount || index > 1 && value.results.some(row => positive(row.id) && Number(row.stage) === 2))) throw new Error('疑问列表分页没有前进，请刷新重试');
        }
        return { all, base };
    }
    function disposeList(binding) { binding.disposed = true;if (binding.vm.fetchStrings === binding.wrapper) binding.vm.fetchStrings = binding.original;nativeLists.delete(binding.vm); }
    function syncNativeList() {
        const vm = listVM();for (const [old, binding] of nativeLists) if (old !== vm || old._isDestroyed) disposeList(binding);
        if (!vm || !context().userId || !vm.$req?.get) return;
        let binding = nativeLists.get(vm);
        if (!binding) {
            binding = { vm, original: vm.fetchStrings, handled: '', disposed: false };
            binding.wrapper = async function(extra = {}) {
                const query = { ...this.$route.query }, ctx = context();
                if (binding.disposed || !managed(query)) return binding.original.call(this, extra);
                binding.handled = this.$route.fullPath;
                try {
                    if (sharing) await sharing.discover(ctx, true);
                    const groupId = String(query.pzGroup || 'all'), current = state(ctx);
                    if (!['all', 'none'].includes(groupId) && !current.groups.some(group => group.id === groupId)) throw new Error('这个分组已不存在，请从小箭头选择其他分组');
                    const { all, base } = await readDisputed(ctx);
                    const selected = all.filter(row => groupId === 'all' || (current.assignments[String(row.id)] || 'none') === groupId);
                    const pages = Math.max(1, Math.ceil(selected.length / PAGE_SIZE));
                    let currentPage = Math.min(pages, Math.max(1, Math.floor(Number(extra.page || query.page) || 1)));
                    const anchor = Number(extra.anchor ?? (extra.page ? undefined : query.anchor)), index = selected.findIndex(row => Number(row.id) === anchor);
                    if (index >= 0 && !extra.page && !query.page) currentPage = Math.floor(index / PAGE_SIZE) + 1;
                    const result = { ...base, results: selected.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE), page: currentPage, pageSize: PAGE_SIZE, rowCount: selected.length, pageCount: pages };
                    binding.result = result;return result;
                } catch (error) { report(error);throw error; }
            };
            vm.fetchStrings = binding.wrapper;nativeLists.set(vm, binding);vm.$once?.('hook:beforeDestroy', () => disposeList(binding));
        }
        // 初始请求可能比脚本绑定更早发出；只在没有待保存译文时补读一次。
        const active = editor();
        if (managed(vm.$route.query) && binding.handled !== vm.$route.fullPath && !vm.loading && !active?.canSave && !active?.saving && typeof vm.initStrings === 'function') {
            const route = vm.$route.fullPath;binding.handled = route;Promise.resolve(vm.initStrings()).then(() => { if (!vm.loading && !binding.disposed && vm.$route.fullPath === route && !editor()?.canSave && !editor()?.saving) vm.onLoad?.(); }).catch(report);
        }
        // 地址同步由已有的分页修复统一处理，避免两个 replace 请求互相取消。
        if (managed(vm.$route.query)) for (const select of doc.querySelectorAll('.strings .pagination-footer select')) {
            if (![...select.options].some(option => option.value === '10')) { const option = node('option', '10');option.value = '10';select.prepend(option); }
            if (Number(vm.strings?.pageSize) === 10 && select.value !== '10') select.value = '10';
        }
    }
    async function goGroup(groupId, ctx = context()) {
        if (!['all', 'none'].includes(groupId) && !state(ctx).groups.some(group => group.id === groupId)) throw new Error('这个分组已不存在');
        if (mounted?.routeMenu) { mounted.routeMenu.hidden = true;mounted.launch.setAttribute('aria-expanded', 'false'); }
        const query = { stage: '2', pzGroup: groupId, page: '1', pageSize: '10' }, path = `/projects/${ctx.projectId}/strings`;
        if (ctx.vm?.$router?.push) await ctx.vm.$router.push({ path, query });
        else page.location.href = `https://paratranz.cn${path}?stage=2&pzGroup=${encodeURIComponent(groupId)}&page=1&pageSize=10`;
    }
    async function showRouteMenu() {
        if (!mounted?.routeMenu) return;
        if (!mounted.routeMenu.hidden) { mounted.routeMenu.hidden = true;mounted.launch.setAttribute('aria-expanded', 'false');return; }
        const ctx = context();if (sharing) await refreshShared(ctx);
        if (!mounted?.routeMenu?.isConnected) return;
        const menu = mounted.routeMenu;menu.replaceChildren();
        const selected = String(listVM()?.$route.query.pzGroup || 'all');
        for (const group of [{ id: 'all', name: '全部疑问' }, { id: 'none', name: '未分组' }, ...state(ctx).groups]) {
            const item = button(group.name, () => goGroup(group.id, ctx), 'dropdown-item');
            if (group.id === selected) { item.classList.add('pz-dg-selected');item.setAttribute('aria-current', 'true'); }menu.append(item);
        }
        menu.append(node('div', null, 'dropdown-divider'), button('管理分组', () => { menu.hidden = true;return openOverview(); }, 'dropdown-item'));menu.hidden = false;mounted.launch.setAttribute('aria-expanded', 'true');
    }
    // ---- 管理分组时读取全部疑问词条，列表每页显示十条 ----
    async function loadRows() {
        const ctx = context(), req = ctx.vm?.$req, ticket = ++request;
        if (!ctx.userId || !req?.get) { report(new Error('请等待项目加载完成'));return; }
        loading = true;loaded = false;rows = [];signature = '';render();
        try {
            if (sharing) await sharing.discover(ctx, true);
            if (ticket !== request || `${ctx.userId}:${ctx.projectId}` !== contextKey || !overviewOpen) return;
            const all = [], ids = new Set();let pageCount = 1;
            for (let index = 1; index <= pageCount; index++) {
                const result = await req.get(`/projects/${ctx.projectId}/strings`, { params: { stage: 2, page: index, pageSize: 800 } });
                if (ticket !== request || `${ctx.userId}:${ctx.projectId}` !== contextKey || !overviewOpen) return;
                const value = result?.results ? result : result?.data;
                if (!Array.isArray(value?.results)) throw new Error('疑问列表返回格式不正确');
                const size = Number(value.pageSize) > 0 ? Number(value.pageSize) : 800;
                const pages = Number(value.pageCount || (value.rowCount != null ? Math.ceil(Number(value.rowCount) / size) : 1));
                if (!Number.isSafeInteger(pages) || pages < 0 || pages > 1000) throw new Error('疑问列表页数不正确');
                pageCount = Math.max(1, pages);
                let added = 0;
                for (const row of value.results) if (positive(row.id) && Number(row.stage) === 2 && !ids.has(Number(row.id))) { ids.add(Number(row.id));all.push(row);added++; }
                if (!added && (index < pageCount || index > 1 && value.results.some(row => positive(row.id) && Number(row.stage) === 2))) throw new Error('疑问列表分页没有前进，请刷新重试');
            }
            rows = all;loaded = true;if (mounted) mounted.status.textContent = '';
        } catch (error) { if (ticket === request) report(error); }
        finally { if (ticket === request) { loading = false;signature = '';render(); } }
    }
    function closeOverview() {
        overviewOpen = false;request++;loading = false;
        if (mounted?.overlay) {
            mounted.panel.hidden = true;mounted.host.prepend(mounted.status, mounted.panel);
            mounted.overlay.remove();mounted.backdrop.remove();mounted.overlay = mounted.backdrop = null;
            if (doc.body.style.overflow === 'hidden') doc.body.style.overflow = mounted.previousOverflow || '';
            if (!mounted.previousModalOpen) doc.body.classList.remove('modal-open');
            if (mounted.previousFocus?.isConnected) mounted.previousFocus.focus?.();
        }
        render();
    }
    function openOverview() {
        if (!overviewOpen) { filter = 'all';listPage = 1; }overviewOpen = true;signature = '';sync();
        if (mounted && !mounted.overlay) {
            const overlay = node('div', null, 'modal show pz-dg-modal');overlay.setAttribute('role', 'dialog');overlay.setAttribute('aria-modal', 'true');overlay.setAttribute('aria-label', '疑问分组');overlay.style.display = 'block';
            const dialog = node('div', null, 'modal-dialog modal-lg'), content = node('div', null, 'modal-content'), head = node('div', null, 'modal-header'), body = node('div', null, 'modal-body'), footer = node('div', null, 'modal-footer');
            const close = button('×', closeOverview, 'close');close.setAttribute('aria-label', '关闭疑问分组');
            head.append(node('h5', '管理疑问分组', 'modal-title'), close);body.append(mounted.status, mounted.panel);footer.append(button('返回', closeOverview, 'btn btn-primary'));
            content.append(head, body, footer);dialog.append(content);overlay.append(dialog);
            overlay.addEventListener('click', event => { if (event.target === overlay) closeOverview(); });
            mounted.overlay = overlay;mounted.backdrop = node('div', null, 'modal-backdrop show pz-dg-backdrop');mounted.previousOverflow = doc.body.style.overflow;mounted.previousFocus = doc.activeElement;mounted.previousModalOpen = doc.body.classList.contains('modal-open');
            doc.body.classList.add('modal-open');doc.body.style.overflow = 'hidden';doc.body.append(mounted.backdrop, overlay);
            page.requestAnimationFrame(() => mounted?.overlay?.querySelector('[aria-label="查看疑问分组"]')?.focus());
        }
        return loadRows();
    }
    function render() {
        if (!mounted) return;
        mounted.panel.hidden = !overviewOpen;
        mounted.launch.setAttribute('aria-expanded', String(!mounted.routeMenu.hidden));
        if (!overviewOpen) return;
        const current = state();if (filter !== 'all' && filter !== 'none' && !current.groups.some(group => group.id === filter)) { filter = 'all';listPage = 1; }
        const selected = rows.filter(row => filter === 'all' || (current.assignments[String(row.id)] || 'none') === filter);
        const totalPages = Math.max(1, Math.ceil(selected.length / PAGE_SIZE));listPage = Math.min(Math.max(1, listPage), totalPages);
        const stamp = JSON.stringify([loading, loaded, filter, listPage, current, sharing?.issueId(context()), rows.map(row => [row.id, row.stage, row.original, row.translation])]);
        if (signature === stamp) return;
        if (mounted.content.contains(doc.activeElement) && doc.activeElement?.tagName === 'INPUT') return;
        signature = stamp;
        const tools = node('div', null, 'pz-dg-tools'), picker = node('select');picker.setAttribute('aria-label', '查看疑问分组');
        const counts = new Map();for (const row of rows) { const id = current.assignments[String(row.id)] || 'none';counts.set(id, (counts.get(id) || 0) + 1); }
        for (const group of [{ id: 'all', name: '全部疑问' }, { id: 'none', name: '未分组' }, ...current.groups]) {
            const option = node('option', `${group.name}${loaded ? ` (${group.id === 'all' ? rows.length : counts.get(group.id) || 0})` : ''}`);option.value = group.id;picker.append(option);
        }
        picker.value = filter;picker.addEventListener('change', () => { filter = picker.value;listPage = 1;signature = '';render(); });
        const reload = button('刷新', loadRows, 'pz-dg-button pz-dg-secondary');reload.disabled = loading;tools.append(picker, reload);
        if (mounted.mode) {
            const ctx = context(), shared = sharing?.value(ctx);
            mounted.mode.replaceChildren();
            if (shared) {
                const link = node('a', `项目 ${ctx.projectId} · 共享分组`);link.href = `/projects/${ctx.projectId}/issues/${sharing.issueId(ctx)}`;mounted.mode.append(link);
            } else {
                mounted.mode.append(node('span', '个人分组', 'pz-dg-mode-badge'), node('small', '仅保存在当前浏览器', 'pz-dg-muted'));
                if (sharing) {
                    const enable = button('启用项目共享', async () => {
                    await sharing.enable(ctx, copy(localState(ctx)));signature = '';queue();
                    }, 'pz-dg-button pz-dg-share');enable.title = '把分组标记保存到项目讨论，装有脚本的成员可共享。';mounted.mode.append(enable);
                }
            }
        }
        if (current.groups.some(group => group.id === filter) && canManageGroup(filter)) {
            const rename = node('form', null, 'pz-dg-create pz-dg-rename'), name = node('input');name.value = current.groups.find(group => group.id === filter).name;name.maxLength = 50;name.setAttribute('aria-label', '修改分组名');rename.hidden = true;
            const save = node('button', '保存', 'pz-dg-button');save.type = 'submit';rename.append(name, save, button('取消', () => { rename.hidden = true; }));
            rename.addEventListener('submit', async event => { event.preventDefault();try { await renameGroup(filter, name.value);rename.hidden = true;name.blur();queue(); } catch (error) { report(error); } });
            tools.append(button('改名', () => { rename.hidden = !rename.hidden;if (!rename.hidden) name.focus(); }), button('删除分组', async () => {
                if (!page.confirm(`${sharing?.value(context()) ? '这是项目共享分组。' : ''}只删除这个分组，组内词条回到未分组；不会删除词条或修改译文。`)) return;
                await removeGroup(filter);filter = 'none';listPage = 1;queue();
            }, 'pz-dg-button pz-dg-danger'), rename);
        }
        const create = newGroupForm(id => { filter = id;listPage = 1;signature = '';render(); });create.classList.add('pz-dg-new-group');create.querySelector('input').placeholder = '新分组名称';
        const list = node('div', null, 'pz-dg-rows');
        if (loading) list.append(node('p', '正在读取疑问词条…', 'pz-dg-muted'));
        else if (loaded) {
            if (!selected.length) {
                const empty = node('div', null, 'pz-dg-empty');empty.append(node('strong', '暂无疑问词条'), node('small', filter === 'all' ? '标记为有疑问的词条会显示在这里。' : '在词条中选择此分组后，会显示在这里。'));list.append(empty);
            }
            for (const row of selected.slice((listPage - 1) * PAGE_SIZE, listPage * PAGE_SIZE)) {
                const item = node('div', null, 'pz-dg-row'), text = node('div', null, 'pz-dg-row-text'), link = node('a', row.original || `词条 ${row.id}`);
                link.href = `/projects/${context().projectId}/strings?id=${Number(row.id)}`;
                text.append(link, node('small', row.translation || '译文为空', 'pz-dg-muted'));
                const ctx = context();item.append(text, groupPicker(current.assignments[String(row.id)], value => assign(row.id, value, ctx), ctx));list.append(item);
            }
        }
        const pagination = node('div', null, 'pz-dg-pagination');
        if (loaded && selected.length) {
            const start = selected.length ? (listPage - 1) * PAGE_SIZE + 1 : 0, end = Math.min(listPage * PAGE_SIZE, selected.length);
            pagination.append(node('span', `${start}–${end} 条 · 共 ${selected.length} 条`, 'pz-dg-muted'));
            const controls = node('div', null, 'pz-dg-page-controls'), pageInput = node('input');pageInput.type = 'number';pageInput.min = '1';pageInput.max = String(totalPages);pageInput.value = String(listPage);pageInput.setAttribute('aria-label', '疑问分组页码');
            const turn = value => { listPage = Math.min(totalPages, Math.max(1, Math.floor(Number(value) || 1)));pageInput.blur();signature = '';render(); };
            pageInput.addEventListener('change', () => turn(pageInput.value));
            pageInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault();turn(pageInput.value); } });
            for (const [label, value, disabled, title] of [['«', 1, listPage === 1, '第一页'], ['‹', listPage - 1, listPage === 1, '上一页']]) {
                const control = button(label, () => turn(value), 'pz-dg-page-button');control.disabled = disabled;control.title = title;controls.append(control);
            }
            controls.append(pageInput, node('span', `/ ${totalPages}`));
            for (const [label, value, disabled, title] of [['›', listPage + 1, listPage === totalPages, '下一页'], ['»', totalPages, listPage === totalPages, '最后一页']]) {
                const control = button(label, () => turn(value), 'pz-dg-page-button');control.disabled = disabled;control.title = title;controls.append(control);
            }
            if (totalPages > 1) pagination.append(controls);pagination.append(node('span', '10 条 / 页', 'pz-dg-muted'));
        }
        mounted.content.replaceChildren(tools, create, list, pagination);
    }
    function placeLaunch(ctx) {
        if (!mounted) return;
        const { host, launch } = mounted;
        if (ctx.route === 'settings') {
            launch.hidden = true;
            const nav = host.querySelector('aside .nav');if (!nav) return;
            if (!mounted.settingsItem?.isConnected) {
                mounted.settingsItem?.remove();
                const item = node('li', null, 'nav-item pz-dg-settings-entry'), control = button('', openOverview, 'nav-link');
                const icon = node('i', null, 'fad fa-circle-question fa-fw');icon.setAttribute('aria-hidden', 'true');control.append(icon, node('span', '疑问管理'));item.append(control);
                const comments = [...nav.querySelectorAll('a')].find(link => /\/settings\/comments\/?$/.test(link.getAttribute('href') || ''))?.closest('.nav-item');
                if (comments) comments.after(item);else nav.append(item);mounted.settingsItem = item;
            }
            return;
        }
        if (ctx.route === 'issues') {
            const reference = [...host.querySelectorAll('a,button')].find(element => /查看\s*\d*\s*有疑问词条|View.*Disputed/i.test(element.textContent));
            launch.hidden = !!reference;launch.textContent = '疑问分组';
            if (mounted.reference !== reference) {
                mounted.reference?.removeEventListener('click', mounted.referenceClick, true);
                mounted.reference = reference;
                mounted.referenceClick = event => {
                    if (event.button > 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                    event.preventDefault();event.stopImmediatePropagation();goGroup('all', ctx).catch(report);
                };
                reference?.addEventListener('click', mounted.referenceClick, true);
            }
            return;
        }
        const breadcrumb = host.querySelector('.breadcrumb');
        if (mounted.breadcrumb !== breadcrumb) { mounted.breadcrumb?.classList.remove('pz-dg-browse-host');mounted.breadcrumb = breadcrumb; }
        if (!breadcrumb) { launch.hidden = true;return; }
        const disputed = [...breadcrumb.querySelectorAll('.breadcrumb-item')].find(element => /^(有疑问|Disputed)/.test(element.textContent.trim()));
        breadcrumb.classList.toggle('pz-dg-browse-host', !!disputed);
        launch.hidden = !disputed;launch.textContent = '';launch.classList.toggle('pz-dg-browse-arrow', !!disputed);
        launch.setAttribute('aria-label', '选择疑问分组');launch.title = '选择疑问分组';
        if (mounted.crumb !== disputed) {
            mounted.crumb?.classList.remove('pz-dg-crumb');mounted.crumb = disputed;mounted.routeMenu.hidden = true;
            if (disputed) { disputed.classList.add('pz-dg-crumb');disputed.append(mounted.groupLabel, launch, mounted.routeMenu); }
        }
        const selected = String(listVM()?.$route.query.pzGroup || 'all');
        mounted.groupLabel.textContent = selected === 'all' ? '' : ` · ${selected === 'none' ? '未分组' : state(ctx).groups.find(group => group.id === selected)?.name || '分组已删除'}`;
    }
    function teardown() {
        if (mounted) {
            if (mounted.overlay) closeOverview();
            mounted.reference?.removeEventListener('click', mounted.referenceClick, true);
            mounted.settingsItem?.remove();mounted.breadcrumb?.classList.remove('pz-dg-browse-host');mounted.crumb?.classList.remove('pz-dg-crumb');mounted.launch.remove();mounted.routeMenu.remove();mounted.groupLabel.remove();mounted.panel.remove();mounted.status.remove();mounted.slot?.remove();
        }
        mounted = null;signature = '';
    }
    function sync() {
        if (destroyed) return;
        const ctx = context(), key = `${ctx.userId}:${ctx.projectId}`;
        if (key !== contextKey) {
            contextKey = key;overviewOpen = false;rows = [];loaded = loading = false;request++;filter = 'all';listPage = 1;signature = '';teardown();for (const binding of [...bindings.values()]) unbind(binding);for (const binding of [...nativeLists.values()]) disposeList(binding);
            if (ctx.projectId && ctx.userId && sharing) sharing.discover(ctx).then(() => { if (key === contextKey) queue(); }).catch(report);
        }
        if (!ctx.projectId || !ctx.userId) return;
        const host = doc.querySelector(ctx.route === 'issues' ? '.issues' : ctx.route === 'settings' ? '.settings' : '.strings');
        if (!host) return;
        if (mounted && (mounted.host !== host || !mounted.launch.isConnected || !mounted.panel.isConnected)) teardown();
        if (!mounted) {
            const launch = button('疑问分组', () => context().route === 'strings' ? showRouteMenu() : openOverview(), 'pz-dg-launch');launch.setAttribute('aria-expanded', 'false');
            const routeMenu = node('div', null, 'dropdown-menu show pz-dg-route-menu');routeMenu.hidden = true;
            const groupLabel = node('span', '', 'pz-dg-group-label');
            const panel = node('section', null, 'pz-dg-panel');panel.hidden = true;
            const head = node('div', null, 'pz-dg-head'), status = node('p', '', 'pz-dg-status'), content = node('div');
            head.append(node('strong', '疑问分组'), button('收起', closeOverview));
            const mode = node('div', null, 'pz-dg-mode');panel.append(head, mode, content);
            const reference = ctx.route === 'issues' && [...host.querySelectorAll('a,button')].find(element => /查看\s*\d*\s*有疑问词条|View.*Disputed/i.test(element.textContent));
            if (reference) reference.after(launch);else host.prepend(launch);
            const header = ctx.route === 'issues' ? host.querySelector('header') : null;
            if (header) header.after(panel);else host.prepend(panel);
            // 保存失败信息始终可见，不会跟着折叠的分组面板一起藏起来。
            status.setAttribute('role', 'alert');panel.before(status);
            mounted = { host, launch, panel, status, content, mode, routeMenu, groupLabel };
        }
        placeLaunch(ctx);syncEditor(editor());syncNativeList();render();
    }
    const api = {
        version: '1.8.2', sync, open: openOverview, managesRoute: managed,
        groups() { return copy(state().groups); }, createGroup,
        assignment(id) { return state().assignments[String(id)] || ''; }, assign,
        destroy() { destroyed = true;request++;for (const binding of [...bindings.values()]) unbind(binding);for (const binding of [...nativeLists.values()]) disposeList(binding);teardown();doc.removeEventListener('click', dismiss);doc.removeEventListener('keydown', dismiss);page.removeEventListener?.('storage', storageChanged);if (page.ParaTranzDisputeGroups === api) delete page.ParaTranzDisputeGroups; }
    };
    function dismiss(event) {
        if (event.type === 'keydown' && mounted?.overlay) {
            if (event.key === 'Escape') { event.preventDefault();event.stopPropagation();closeOverview();return; }
            if (event.key === 'Tab') {
                const controls = [...mounted.overlay.querySelectorAll('button,input,select,a[href]')].filter(element => !element.disabled && !element.closest('[hidden]'));
                const first = controls[0], last = controls[controls.length - 1], active = doc.activeElement;
                if (event.shiftKey && (active === first || !mounted.overlay.contains(active))) { event.preventDefault();last?.focus(); }
                else if (!event.shiftKey && (active === last || !mounted.overlay.contains(active))) { event.preventDefault();first?.focus(); }
            }
        }
        if (event.type === 'keydown' && event.key !== 'Escape') return;
        if (mounted?.routeMenu && (event.type === 'keydown' || !mounted.routeMenu.contains(event.target) && !mounted.launch.contains(event.target))) { mounted.routeMenu.hidden = true;mounted.launch.setAttribute('aria-expanded', 'false'); }
        for (const binding of bindings.values()) if (binding.popup && (event.type === 'keydown' || !binding.popup.contains(event.target) && !binding.arrow?.contains(event.target))) binding.popup.hidden = true;
    }
    function storageChanged(event) {
        if (event.key !== KEY) return;
        try { const parsed = JSON.parse(event.newValue) || {};if (typeof parsed !== 'object' || Array.isArray(parsed)) return;data = parsed;signature = '';queue(); } catch { /* 保留上次有效分组 */ }
    }
    doc.addEventListener('click', dismiss);doc.addEventListener('keydown', dismiss);page.addEventListener?.('storage', storageChanged);
    page.ParaTranzDisputeGroups = api;
    function start() {
        if (!doc.getElementById('pz-dispute-group-style')) {
            const style = node('style');style.id = 'pz-dispute-group-style';style.textContent =
                '.pz-dg-panel[hidden],.pz-dg-launch[hidden],.pz-dg-choices[hidden],.pz-dg-create[hidden],.pz-dg-route-menu[hidden]{display:none!important}.pz-dg-launch{margin:0 0 0 10px;padding:3px 8px;border:1px solid #007bff;border-radius:5px;background:transparent;color:#007bff;font-size:.875em;cursor:pointer;vertical-align:middle}.pz-dg-crumb{position:relative}.pz-dg-browse-host{position:relative;padding-right:44px!important}.pz-dg-browse-host>.pz-dg-crumb{position:static}.pz-dg-browse-host .pz-dg-browse-arrow{position:absolute;right:10px;top:50%;transform:translateY(-50%);margin:0}.pz-dg-launch.pz-dg-browse-arrow{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;margin-left:4px;padding:0;border:0;border-radius:4px;color:inherit;background:transparent;vertical-align:middle;line-height:1}.pz-dg-browse-arrow::after,.pz-dg-arrow::after{content:"";display:block;width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-top:6px solid currentColor}.pz-dg-browse-arrow[aria-expanded="true"]::after{transform:rotate(180deg)}.pz-dg-browse-arrow:hover{background:#6c757d12}.pz-dg-browse-arrow:focus-visible{outline:2px solid #007bff;outline-offset:2px}.pz-dg-route-menu{top:calc(100% + 6px);left:auto;right:0;width:max-content;min-width:132px;max-width:min(260px,85vw);max-height:320px;overflow:auto;padding:4px;border:1px solid #adb5bd55;border-radius:8px;box-shadow:0 4px 16px #00000014;background:var(--pt-bg,#fff);color:var(--pt-fg,#212529);font-size:.875rem;z-index:1030}.pz-dg-route-menu>.dropdown-item{padding:5px 12px;border-radius:4px;font:inherit;line-height:1.4;white-space:normal;overflow-wrap:anywhere}.pz-dg-route-menu>.dropdown-item:hover,.pz-dg-route-menu>.dropdown-item:focus-visible{background:#007bff0d;color:#007bff}.pz-dg-route-menu>.pz-dg-selected{background:#007bff12;color:#007bff}.pz-dg-route-menu>.dropdown-divider{margin:4px 8px;border-color:#adb5bd33}.pz-dg-group-label{color:inherit}.pz-dg-settings-entry>.nav-link{width:100%;border:0;background:transparent;text-align:left;font:inherit}.pz-dg-settings-entry .fa-fw{margin-right:.5em}' +
                '.pz-dg-panel{margin:10px 0 16px;padding:14px;border:1px solid #adb5bd55;border-radius:8px;font-size:.875rem}.pz-dg-head,.pz-dg-tools,.pz-dg-create,.pz-dg-editor-group{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.pz-dg-head{justify-content:space-between;margin-bottom:4px}.pz-dg-tools{margin-top:12px}.pz-dg-create{margin:10px 0}' +
                '.pz-dg-button{border:0;background:transparent;color:#007bff;padding:5px 8px;cursor:pointer;font:inherit}.pz-dg-panel input,.pz-dg-panel select,.pz-dg-editor-group select,.pz-dg-choices input{font:inherit;border:1px solid #adb5bd66;border-radius:5px;padding:5px 8px;background:transparent;color:inherit;max-width:100%}.pz-dg-muted{color:#6c757d}.pz-dg-status:empty{display:none}.pz-dg-status{color:#b42318;margin:8px 0}' +
                '.pz-dg-rows{max-height:55vh;overflow:auto}.pz-dg-row{display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid #adb5bd33}.pz-dg-row-text{flex:1;min-width:0}.pz-dg-row-text>a,.pz-dg-row-text>small{display:block;overflow-wrap:anywhere;white-space:pre-wrap}.pz-dg-row .pz-dg-picker{width:160px;flex-shrink:0}.pz-dg-picker>select{width:100%}.pz-dg-picker .pz-dg-create input{min-width:0;width:100%}' +
                '.pz-dg-menu-row{position:relative}.pz-dg-target{padding-right:42px!important}.pz-dg-arrow{display:flex;align-items:center;justify-content:center;position:absolute;right:6px;top:3px;width:30px;height:30px;border:0;border-radius:5px;background:transparent;color:#007bff;cursor:pointer;font-size:20px;line-height:1}.pz-dg-choices{position:absolute;right:0;top:100%;z-index:1080;width:240px;max-width:85vw;max-height:320px;overflow:auto;padding:10px;background:var(--pt-bg,#fff);color:var(--pt-fg,#212529);border:1px solid #adb5bd66;border-radius:6px;box-shadow:0 5px 16px #0002}' +
                '.pz-dg-choices>.pz-dg-button{display:block;width:100%;text-align:left}.pz-dg-choices .pz-dg-create{flex-wrap:nowrap}.pz-dg-choices input{min-width:0;width:100%}.pz-dg-editor-group{margin:10px 0;font-size:.875rem}' +
                '.pz-dg-pagination{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;padding-top:12px}.pz-dg-page-controls{display:flex;align-items:center;gap:6px}.pz-dg-page-button{background:transparent;color:#007bff;border:1px solid #adb5bd66;padding:5px 10px;border-radius:5px;font:inherit;cursor:pointer}.pz-dg-page-button:disabled{color:#6c757d;opacity:.5;cursor:default}.pz-dg-page-controls input{width:62px;text-align:center}' +
                '.pz-dg-modal{z-index:1050;overflow:auto}.pz-dg-backdrop{z-index:1040}.pz-dg-modal .pz-dg-head{display:none}.pz-dg-modal .pz-dg-panel{margin:0;padding:0;border:0}.pz-dg-modal .modal-body{padding:1rem}.pz-dg-modal .pz-dg-rows{max-height:50vh}.pz-dg-modal .pz-dg-launch{display:none}' +
                '.pz-dg-modal{display:flex!important;align-items:center;justify-content:center;padding:20px;font-size:14px}.pz-dg-modal .modal-dialog{width:100%;max-width:560px;margin:0;max-height:calc(100vh - 40px)}.pz-dg-modal .modal-content{max-height:calc(100vh - 40px);border-radius:10px;border:1px solid #adb5bd55;overflow:hidden;box-shadow:0 12px 48px #0003}.pz-dg-modal .modal-header{padding:14px 20px;align-items:center}.pz-dg-modal .modal-title{font-size:16px;font-weight:600;line-height:1.4}.pz-dg-modal .close{margin:0;padding:0;width:28px;height:28px;font-size:24px;line-height:1;opacity:.6}.pz-dg-modal .modal-body{padding:16px 20px;overflow:auto;min-height:0}.pz-dg-modal .modal-footer{padding:10px 20px}.pz-dg-modal .modal-footer .btn{font-size:14px;padding:6px 16px}.pz-dg-modal .pz-dg-panel{font-size:inherit}.pz-dg-modal .pz-dg-mode{font-size:12px;gap:8px;border-bottom:1px solid #adb5bd33;padding-bottom:12px;margin-bottom:12px}.pz-dg-mode-badge{background:#6c757d12;border-radius:4px;padding:3px 7px}.pz-dg-modal .pz-dg-share{margin-left:auto;font-size:12px;padding:4px 8px}.pz-dg-modal .pz-dg-tools{margin:0;gap:6px}.pz-dg-modal .pz-dg-tools>select{flex:1;min-width:130px;width:0;height:34px}.pz-dg-modal .pz-dg-button{padding:6px 8px;line-height:1.4;white-space:nowrap}.pz-dg-modal .pz-dg-secondary{border:1px solid #adb5bd66;border-radius:5px;color:#6c757d}.pz-dg-modal .pz-dg-danger{color:#c54545}.pz-dg-modal .pz-dg-rename{flex-basis:100%;margin:4px 0 0;padding:10px;background:#f8f9fa;border-radius:6px}.pz-dg-modal .pz-dg-rename>input{flex:1;min-width:100px;width:0}.pz-dg-modal .pz-dg-new-group{margin:12px 0;flex-wrap:nowrap;padding:10px;border:1px solid #adb5bd33;border-radius:6px;background:#f8f9fa}.pz-dg-modal .pz-dg-new-group>input{flex:1;min-width:0;width:0;background:var(--pt-bg,#fff)}.pz-dg-modal .pz-dg-new-group>button{background:#007bff;color:white;border-radius:5px;padding:6px 12px}.pz-dg-modal .pz-dg-rows{max-height:min(360px,42vh)}.pz-dg-modal .pz-dg-row{padding:10px 0;gap:12px}.pz-dg-modal .pz-dg-row .pz-dg-picker{width:128px}.pz-dg-modal .pz-dg-row-text>a{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;white-space:normal;overflow:hidden;line-height:1.5}.pz-dg-modal .pz-dg-row-text>small{white-space:nowrap;text-overflow:ellipsis;overflow:hidden;font-size:12px;margin-top:3px}.pz-dg-empty{padding:24px 12px;text-align:center;color:#6c757d;border-radius:6px;background:#f8f9fa}.pz-dg-empty strong{display:block;font-size:14px;font-weight:500}.pz-dg-empty small{display:block;font-size:12px;line-height:1.5;margin-top:6px}.pz-dg-modal .pz-dg-pagination{font-size:12px;gap:8px;border-top:1px solid #adb5bd33;margin-top:8px;padding-top:10px}.pz-dg-pagination:empty{display:none}.pz-dg-modal .pz-dg-page-controls{gap:3px}.pz-dg-modal .pz-dg-page-controls input{width:42px;padding:4px}.pz-dg-modal .pz-dg-page-button{padding:4px 7px}@media(max-width:480px){.pz-dg-modal{padding:12px}.pz-dg-modal .modal-body{padding:12px}.pz-dg-modal .modal-header,.pz-dg-modal .modal-footer{padding:12px}.pz-dg-modal .pz-dg-row{align-items:flex-start}.pz-dg-modal .pz-dg-row .pz-dg-picker{width:100px}.pz-dg-modal .pz-dg-pagination{justify-content:center}.pz-dg-modal .pz-dg-mode small{flex:1}}' +
                '.pz-dg-prompt-group{display:flex;flex-direction:column;gap:8px;margin-top:14px;font-size:.875rem}.pz-dg-prompt-group select,.pz-dg-prompt-group input{border:1px solid #adb5bd66;border-radius:5px;background:transparent;color:inherit;padding:7px 10px;font:inherit;width:100%}.pz-dg-prompt-group .pz-dg-create{flex-wrap:nowrap}.pz-dg-mode{display:flex;align-items:center;flex-wrap:wrap;gap:6px;color:#6c757d;font-size:.875em}';doc.head?.append(style);
        }
        sync();
    }
    if (doc.body) start();else doc.addEventListener('DOMContentLoaded', start, { once: true });
})();

// ===== 功能：在保存前检查中提示空白格式，并修复当前译文草稿 =====
(() => {
    'use strict';
    const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window, doc = page.document;
    const bindings = new Map();let destroyed = false, queued = false;
    const H = '[ \\t\\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000]';
    const leading = new RegExp('^' + H + '*'), trailing = new RegExp(H + '*$'), blank = new RegExp('^' + H + '*$');
    function parts(line) {
        const before = leading.exec(line)[0], rest = line.slice(before.length), after = trailing.exec(rest)[0];
        return { before, after, body: rest.slice(0, rest.length - after.length), blank: blank.test(line) };
    }
    function inspect(original, translation, lineBreak = '\n') {
        original = String(original ?? '');translation = String(translation ?? '');
        if (!translation || !original) return { issues: [], fixed: translation, repairable: false };
        const custom = lineBreak && !/^\r?\n$|^\r$/.test(lineBreak) ? String(lineBreak) : '';
        const escaped = custom.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const split = new RegExp('(\\r\\n|\\r|\\n' + (custom ? '|' + escaped : '') + ')');
        const source = original.split(split), target = translation.split(split);
        const sourceLines = source.filter((_, i) => i % 2 === 0).map(parts), targetLines = target.filter((_, i) => i % 2 === 0).map(parts);
        const meaningfulSource = sourceLines.filter(line => !line.blank), meaningfulTarget = targetLines.filter(line => !line.blank);
        if (!meaningfulSource.length) return { issues: [], fixed: translation, repairable: false };
        const issues = [], equalBodies = meaningfulSource.length === meaningfulTarget.length;
        const spaceName = value => {
            const spaces = [...value].filter(char => char === ' ').length, tabs = [...value].filter(char => char === '\t').length, other = value.length - spaces - tabs;
            return [spaces && `${spaces} 个空格`, tabs && `${tabs} 个制表符`, other && `${other} 个其他空白`].filter(Boolean).join('、') || '无空白';
        };
        let index = 0;
        for (const [i, line] of sourceLines.entries()) {
            if (line.blank) continue;
            const translated = equalBodies ? meaningfulTarget[index++] : targetLines[i];if (!translated || translated.blank) continue;
            if (line.before !== translated.before) issues.push(`第 ${i + 1} 行行首缩进不同：原文${spaceName(line.before)}，译文${spaceName(translated.before)}`);
            if (line.after !== translated.after) issues.push(`第 ${i + 1} 行行尾空白不同：原文${spaceName(line.after)}，译文${spaceName(translated.after)}`);
        }
        const sameBlankLayout = sourceLines.length === targetLines.length && sourceLines.every((line, i) => line.blank === targetLines[i].blank);
        if (!sameBlankLayout && (sourceLines.some(line => line.blank) || targetLines.some(line => line.blank))) issues.push('译文的空行数量或位置与原文不同');
        else if (sameBlankLayout && sourceLines.some((line, i) => line.blank && source[i * 2] !== target[i * 2])) issues.push('空行中的空白字符与原文不同');
        if (!equalBodies) issues.push('正文行数不同，无法仅通过调整空白修复');
        let fixed = translation;
        // 不拼接正文行。带自定义换行标签时，也不增删标签来修复空行。
        const repairable = equalBodies && (!custom || sourceLines.length === targetLines.length && sameBlankLayout);
        if (repairable) {
            index = 0;
            const eol = target.find((_, i) => i % 2 === 1) || source.find((_, i) => i % 2 === 1) || '\n';
            const separators = target.filter((_, i) => i % 2 === 1);
            const rebuilt = sourceLines.map((line, i) => line.blank ? source[i * 2] : line.before + meaningfulTarget[index++].body + line.after);
            fixed = rebuilt.map((line, i) => line + (i < rebuilt.length - 1 ? custom ? separators[i] : eol : '')).join('');
        }
        return { issues, fixed, repairable: repairable && fixed !== translation };
    }
    function editor() {
        let vm = doc.querySelector('.string-editor')?.__vue__;
        for (let i = 0; vm && i < 16; i++, vm = vm.$parent) if (vm.$options?.name === 'stringEditor' && vm.item && typeof vm.preSaveCheck === 'function') return vm;
        return null;
    }
    function snapshot(vm) { return { vm, id: Number(vm.item.id), project: String(vm.projectId), original: String(vm.item.original ?? ''), text: String(vm.translation ?? '') }; }
    function current(value) { const vm = value.vm;return editor() === vm && Number(vm.item?.id) === value.id && String(vm.projectId) === value.project && String(vm.item.original ?? '') === value.original && String(vm.translation ?? '') === value.text; }
    function node(tag, text, className) { const el = doc.createElement(tag);if (text != null) el.textContent = text;if (className) el.className = className;return el; }
    function removeUI(binding) { binding.ui?.remove();binding.ui = null;binding.stamp = ''; }
    function queue() { if (queued || destroyed) return;queued = true;page.requestAnimationFrame(() => { queued = false;if (!destroyed) sync(); }); }
    function unbind(binding) {
        if (binding.checking) binding.vm.onConfirmCancel?.();
        if (binding.vm.preSaveCheck === binding.wrapper) binding.vm.preSaveCheck = binding.original;
        removeUI(binding);bindings.delete(binding.vm);
    }
    function bind(vm) {
        if (bindings.has(vm)) return bindings.get(vm);
        const binding = { vm, original: vm.preSaveCheck, checking: null, ui: null, stamp: '' };
        binding.wrapper = function(...args) {
            if (binding.checking) return false;
            const captured = snapshot(this), analysis = inspect(captured.original, captured.text, this.lineBreakChar);
            let result;
            try { result = binding.original.call(this, ...args); } catch (error) { throw error; }
            if (!analysis.issues.length) return result;
            // 网站已有检查失败时，复用它正在打开的同一个弹窗。
            if (result === true && analysis.issues.length && this.$bvModal?.show) {
                result = new Promise(resolve => {
                    this.onConfirmOK = () => resolve(true);this.onConfirmCancel = () => resolve(false);this.onConfirmHidden = () => resolve(null);
                    this.$bvModal.show('tagConfirm');
                });
            }
            if (!result?.then) return result;
            binding.checking = { captured, analysis };queue();
            return Promise.resolve(result).then(ok => current(captured) ? ok : false).finally(() => { binding.checking = null;removeUI(binding);queue(); });
        };
        vm.preSaveCheck = binding.wrapper;vm.$once?.('hook:beforeDestroy', () => unbind(binding));bindings.set(vm, binding);return binding;
    }
    function repair(binding) {
        const check = binding.checking;if (!check) return;
        const { captured, analysis } = check, vm = binding.vm;
        if (!current(captured) || vm.canEdit === false || vm.saving || vm.polishing || !analysis.repairable) return;
        // replace 使用网站自己的编辑器撤销历史；不提交、不改变词条状态。
        vm.$refs?.editor?.replace?.(analysis.fixed);
        if (String(vm.translation ?? '') !== analysis.fixed) vm.translation = analysis.fixed;
        vm.onTranslationChange?.(analysis.fixed);
        // 本次保存按取消处理，避免保存入口使用修复前的文本快照继续提交。
        vm.onConfirmCancel?.();vm.$bvModal?.hide?.('tagConfirm');removeUI(binding);
        vm.$alert?.success?.('空白格式已修复，请重新点击保存');
    }
    function sync() {
        if (destroyed) return;
        const vm = editor();for (const [old, binding] of bindings) if (old !== vm || old._isDestroyed) unbind(binding);
        if (!vm) return;
        const binding = bind(vm), check = binding.checking;
        if (!check || !check.analysis.issues.length) { removeUI(binding);return; }
        const body = doc.getElementById('tagConfirm___BV_modal_body_') || doc.querySelector('#tagConfirm .modal-body');if (!body) return;
        const usable = current(check.captured) && vm.canEdit !== false && !vm.saving && !vm.polishing;
        const stamp = JSON.stringify([check.captured.id, check.captured.text, check.analysis.issues, usable]);
        if (binding.ui?.isConnected && binding.ui.parentElement === body && binding.stamp === stamp) return;
        removeUI(binding);binding.stamp = stamp;
        const ui = node('section', null, 'pz-whitespace-check'), heading = node('div', null, 'pz-whitespace-heading');
        heading.append(node('i', null, 'far fa-exclamation-circle'), node('strong', '空白格式检查'));
        const list = node('ul');for (const issue of check.analysis.issues.slice(0, 6)) list.append(node('li', issue));
        if (check.analysis.issues.length > 6) list.append(node('li', `另有 ${check.analysis.issues.length - 6} 处空白格式不同`));
        const controls = node('div', null, 'pz-whitespace-actions'), fix = node('button', '修复空格', 'btn btn-outline-primary btn-sm');fix.type = 'button';fix.disabled = !usable || !check.analysis.repairable;
        fix.addEventListener('click', event => { event.preventDefault();event.stopPropagation();repair(binding); });
        controls.append(fix, node('small', check.analysis.repairable ? '按原文恢复缩进及行尾空白；修复后重新保存。' : '正文行或换行标签不同，需手动调整。'));
        ui.append(heading, list, controls);body.append(ui);binding.ui = ui;
    }
    const api = { version: '1.8.3', inspect, sync, destroy() { destroyed = true;for (const binding of [...bindings.values()]) unbind(binding);if (page.ParaTranzWhitespaceCheck === api) delete page.ParaTranzWhitespaceCheck; } };
    page.ParaTranzWhitespaceCheck = api;
    function start() {
        if (!doc.getElementById('pz-whitespace-check-style')) {
            const style = node('style');style.id = 'pz-whitespace-check-style';style.textContent = '.pz-whitespace-check{margin-top:14px;padding-top:12px;border-top:1px solid #adb5bd55;font-size:.875rem}.pz-whitespace-heading{display:flex;align-items:center;gap:7px}.pz-whitespace-heading strong{font-weight:500}.pz-whitespace-check ul{padding-left:22px;margin:8px 0;line-height:1.6}.pz-whitespace-actions{display:flex;align-items:center;flex-wrap:wrap;gap:10px}.pz-whitespace-actions small{color:#6c757d}';doc.head?.append(style);
        }
        sync();
    }
    if (doc.body) start();else doc.addEventListener('DOMContentLoaded', start, { once: true });
})();
