# Home Phase 5 摘要

## 输出

生成祁煜专属整屋 preset 两份：`public/pixel-presets/269e621d-b1d0-4176-96ff-e986188c7438.json` 与 `outputs/baishawan_pixelhome/白沙湾_MoArtStudio_整屋预设.json`，内容一致。

## 内容

共 9 房、38 个内嵌轻量像素 SVG assets、85 件预摆家具；包含门牌、黑门、塞壬雕像、创作大厅四分区、星空穹顶及临海平台等要求元素，无外部 URL。旧七室 preset 未改，DB 仍 v72。

## 导入兼容

新增可选 `replaceRoomCatalog` 整屋标志，仅本包启用：目标角色已有七室时目录替换为九室，但旧布局记录不物理删除；其他角色不受影响。旧 preset 缺少此标志时仍按原逻辑合并。

## 验证

Phase 4/5 定向测试 8/8 通过：解析、双文件一致、新角色九房、已有七室替换、角色隔离、85 件家具和 38 assets 恢复。production build 通过。

## 风险

自定义九房使用 Phase 4 的滚动入口与通用编辑画布；旧七室平面图、记忆潜行模型未重写。
