# Phase 6 Dollhouse 摘要

## 修改

PWA：`utils/keepAlive.ts`、`worker/sw-keep-alive.ts`及生成的`public/sw-keep-alive.js`。Pixel Home：`types.ts`、`mapLayout.ts`、`pixelHomeDb.ts`、`presetManager.ts`、`PixelHomeMap.tsx`、新建`PixelHomeDollhouse.tsx`；同步两份白沙湾 preset 与定向测试。

## 实现与兼容

SW 1.17.0 对 HTML 导航执行 no-store，激活时刷新旧主屏幕页面；不清理 Cache Storage/IndexedDB。新增可选`mapLayout`，随现有房间 metadata 记录持久化，无需升库。白沙湾按实际空间关系显示 9 房剖切图、海面、穹顶与家具预览；点击沿用原房间数据。旧导入可自动补读总图；旧七室和无总图自定义家园保持原样。

## 验证/风险

定向测试 12/12 通过，preset 两份一致，9 房/9 入口正确，production build 通过，DB 仍 v72。全库 typecheck 仍有本轮前已存的无关错误；本轮文件无新错误。真机自动更新需下次部署后验收。
