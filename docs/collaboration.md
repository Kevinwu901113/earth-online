# 协作配置

## GitHub

- 仓库：<https://github.com/Kevinwu901113/earth-online>
- 所有者：`Kevinwu901113`
- 可见性：私有（Private）
- 文档分支：`main`
- 文档目录：`docs/`

本次初始化未邀请成员、未发布公开站点、未购买套餐。

## GitBook

当前状态：仅准备了仓库侧配置，GitBook 尚未登录、未创建文档空间、未建立同步。

后续设置：

1. 用户登录 GitBook；如出现服务条款、GitHub OAuth 或应用权限审批，由用户完成。
2. 创建供项目使用的私有协作文档空间；确认实际套餐支持所需协作及同步功能。出现付费选项时先由用户决定。
3. 在文档空间设置 Git Sync，选择 `Kevinwu901113/earth-online` 与 `main`。如需安装 GitBook GitHub App，仅授权此项目仓库。
4. 仓库根目录包含 `.gitbook.yaml`，其中 `root: ./docs/` 指向文档目录。若界面要求配置文件所在目录，选择仓库根目录。
5. 首次同步选择 **GitHub → GitBook**，导入现有文档。
6. 确认首页与目录正常显示，再通过一处可回滚的文档修改验证双向同步，并记录验证结果。

GitBook 内共同编辑与 GitHub 同步是不同环节；在双向验证完成前，不将同步标记为已完成。邀请另一位协作者及任何公开发布均须另行明确授权。

参考：[GitBook 官方同步导入指南](https://gitbook.com/docs/guides/editing-and-publishing-documentation/import-or-migrate-your-content-to-gitbook-with-git-sync)。
