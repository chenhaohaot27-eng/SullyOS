# Home Phase 4 摘要

## 修改文件

修改 Pixel Home 的类型、模板、存储、preset、主视图、地图、编辑器及装修上下文；新增 `PixelRoomManager.tsx`、定向测试。

## 最终结构

房间目录保存为现有 `pixel_home_layouts` 的特殊记录 `[charId, __pixel_home_room_metadata__]`，每项含 `id/name/order/width/height`；布局、家具仍用 `[charId, roomId]`。无新表，DB 仍 v72。手机端支持增、改名、删、上下排序；地图保留旧平面图并增加滚动入口。

## 旧数据兼容

无目录的旧角色首次读取自动写入七室 metadata，已有布局、家具不变，仅补缺失布局。旧 v1 preset 仍按七室兼容；新 preset 可创建新房间并恢复布局、家具、资产。角色间按 `charId` 隔离。

## 测试 / Build

定向测试 5/5 通过：七室无损、增改删排、角色隔离、新旧 preset 与家具资产恢复。production build 通过；全局 typecheck 仅有既有基线错误，无新增 Pixel Home 类型错误。

## 风险

删除房间经确认后移除布局，无回收站。记忆潜行仍使用旧七室模型；自定义房间走滚动入口与通用编辑画布，本轮未重写任意户型地图。
