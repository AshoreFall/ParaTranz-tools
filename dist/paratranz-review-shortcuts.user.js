// ==UserScript==
// @name         ParaTranz 直接标记已审核
// @namespace    local.paratranz.review-shortcut
// @version      1.2.3
// @description  增加空译文审核和“保存并检查”（管理员可用），修复注释 @ 候选人点击时失焦导致补全失败。
// @match        https://paratranz.cn/projects/*/strings*
// @grant        unsafeWindow
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/AshoreFall/ParaTranz-tools/main/dist/paratranz-review-shortcuts.meta.js
// @downloadURL  https://raw.githubusercontent.com/AshoreFall/ParaTranz-tools/main/dist/paratranz-review-shortcuts.user.js
// ==/UserScript==

(() => {
    'use strict';

    // 本文件包含三个功能：空译文审核、保存并检查、注释 @ 点击补全。
    // 修改功能时，找到下面对应的中文注释即可。
    // ===== 运行状态 =====
    const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const doc = page.document;
    const ID = 'pz-direct-reviewed-shortcut';
    let mounted = null;
    let pending = false;
    let scheduled = false;

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

    function disabledReason(vm, targetStage = 5) {
        if (pending || vm?.saving) return '正在保存，请稍候';
        if (!allowed(vm)) return '仅项目所有者和管理员可用';
        if (!Number.isSafeInteger(Number(vm.item?.id)) || Number(vm.item.id) <= 0) return '请先选择词条';
        if (Number(vm.item.stage) === 5) return '当前词条已经是已审核';
        if (Number(vm.item.stage) === 9) return '请先通过原生菜单解锁词条';
        if (Number(vm.item.stage) === -1) return '请先通过原生菜单取消隐藏';
        if (!vm.canEdit) return '当前词条不可编辑或由其他成员编辑中';
        if (targetStage === 3 && !vm.canSave) return '没有需要保存的译文修改';
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

    // ===== 功能：空译文审核、保存并检查 =====
    async function setStage(targetStage) {
        const vm = editorVM();
        const reason = disabledReason(vm, targetStage);
        if (reason) {
            tell(vm, 'error', reason);
            return;
        }
        const id = Number(vm.item.id);
        const project = Number(vm.projectId);
        const translation = vm.translation;
        const stage = Number(vm.item.stage);
        const saveTranslation = Boolean(vm.canSave);
        const action = targetStage === 3 ? '检查' : '审核';
        pending = true;
        sync();
        let ownsSaving = false;
        try {
            // 使用网站原有的保存前检查。
            if (typeof vm.preSaveCheck !== 'function') throw new Error('页面编辑器版本不兼容，请更新脚本');
            // 允许空译文审核；和网站一样，只检查非空文本。
            if (translation && !await vm.preSaveCheck()) return;
            if (editorVM() !== vm || Number(vm.projectId) !== project || Number(vm.item.id) !== id ||
                Number(vm.item.stage) !== stage || vm.translation !== translation || !allowed(vm) || !vm.canEdit || vm.saving) {
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
                vm.$emit('save', result);
                tell(vm, 'success', `词条已标记为${stageName(targetStage)}（服务器已确认）`);
            } else {
                tell(vm, 'success', `原词条 ${id} 已标记为${stageName(targetStage)}（服务器已确认）；当前编辑内容已保留。`);
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
        mounted?.checkLi.remove();
        mounted = null;
    }

    function sync() {
        scheduled = false;
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
        if (mounted && (!mounted.li.isConnected || mounted.anchor !== anchor)) unmount();
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
            button.addEventListener('click', () => setStage(5));
            li.appendChild(button);
            anchor.before(li);
            const checkLi = doc.createElement('li');
            checkLi.id = `${ID}-checked`;
            checkLi.setAttribute('role', 'presentation');
            const checkButton = doc.createElement('button');
            checkButton.type = 'button';
            checkButton.className = 'dropdown-item';
            checkButton.setAttribute('role', 'menuitem');
            checkButton.textContent = '保存并检查';
            checkButton.addEventListener('click', () => setStage(3));
            checkLi.appendChild(checkButton);
            mounted = { li, button, anchor, checkLi, checkButton, checkAnchor: null };
        }
        // 把“保存并检查”放在“保存并审核”下面。
        const items = [...host.querySelectorAll('.dropdown-item')];
        const saveReview = items.find(el => /^(保存并审核|Save and Review)$/.test(el.textContent.trim()))?.closest('li');
        const firstStatus = items.find(el => /^(标记为已翻译|标记为有疑问|标记为未翻译|Mark as Translated|Mark as Disputed|Mark as Untranslated)$/.test(el.textContent.trim()))?.closest('li') || anchor;
        const checkAnchor = saveReview || firstStatus;
        if (!mounted.checkLi.isConnected || mounted.checkAnchor !== checkAnchor) {
            if (saveReview) saveReview.after(mounted.checkLi);
            else firstStatus.before(mounted.checkLi);
            mounted.checkAnchor = checkAnchor;
        }
        const checkReason = disabledReason(vm, 3);
        if (mounted.checkButton.disabled !== Boolean(checkReason)) mounted.checkButton.disabled = Boolean(checkReason);
        const checkTitle = checkReason || '保存当前译文并标记为已检查，只处理当前词条';
        if (mounted.checkButton.title !== checkTitle) mounted.checkButton.title = checkTitle;
        const reason = disabledReason(vm);
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

    // ===== 启动与页面切换 =====
    new page.MutationObserver(schedule).observe(doc.body, { childList: true, subtree: true, characterData: true });
    page.setInterval(schedule, 700);
    page.addEventListener('popstate', schedule);
    sync();

})();
