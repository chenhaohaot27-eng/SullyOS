# Phase 5 导入显示修复

## 原因与修复

`replaceRoomCatalog:true` 的 IndexedDB 写入已验证：已有七室的目标角色会变为白沙湾 9 房，布局与 85 件家具均可读取。问题在主页仍以旧七室平面图为主体，自定义目录没有明确展示分支。

新增纯判断 `isLegacyPixelRoomCatalog`：仅完整原七室显示旧平面图；含自定义 roomId 或非七室数量时，主页直接显示按 metadata 排序的响应式房间卡片。卡片含素材预览、尺寸、家具数与氛围，点击沿用原编辑页并显示预摆家具。

## Assets

空库首次导入写入 38 assets；再次导入显示“0 个新资产”是 ID 去重，库中 38 项及家具引用均完整，importer 无需修改。

## 回归

Phase 4/5 定向测试 8/8 通过：旧七室地图、白沙湾九房卡片、目录替换、角色隔离、assets 去重及家具恢复。production build 通过；DB 仍 v72，禁改模块未触碰。
