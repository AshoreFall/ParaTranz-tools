# ParaTranz-tools

一个给 ParaTranz 词条编辑页面用的小脚本，补上几个平时校对时不太顺手的地方。

目前有三个功能：

- **空译文也能审核**：保存菜单里增加“标记为已审核”，有译文修改时会一起保存。
- **保存并检查**：保存当前修改，把词条标记为“已检查”。
- **修复注释 @ 补全**：点击下面的候选用户名时，避免列表提前消失、名字填不进去。

审核和检查需要当前项目的所有者或管理员权限，每次只处理当前词条。

## 安装

先装好 Tampermonkey（油猴），再 [点击这里安装脚本](https://raw.githubusercontent.com/AshoreFall/ParaTranz-tools/main/dist/paratranz-review-shortcuts.user.js)。安装后刷新 ParaTranz 页面就能用了，已经装过的直接更新原脚本。

保持油猴自动更新开启，以后仓库发布新版时就能收到更新。

## 以后怎么改

完整代码在 `dist/paratranz-review-shortcuts.user.js`，每个功能前都有中文注释，找到对应位置修改就行。

`dist/paratranz-review-shortcuts.meta.js` 是给油猴检查版本用的小文件。发布新版时提高两个文件里的 `@version`，一起上传，文件名和更新链接保持原样。
