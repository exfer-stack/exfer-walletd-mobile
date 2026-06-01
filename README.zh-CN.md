<h1 align="center">exfer 钱包</h1>

<p align="center"><b>一个装在自己手机里的 Exfer 钱包,密钥只存在你手机上。</b></p>

<p align="center"><a href="README.md">English</a> · <b>简体中文</b></p>

---

## 怎么下载

- **安卓手机** —— 打开 **[最新版本](https://github.com/exfer-stack/exfer-walletd-mobile/releases/latest)**,
  在 **Assets** 里下那个 `.apk` 文件,点开装上就行(安卓会问要不要允许安装,点「允许」)。
- **电脑(Windows / Mac / Linux)** —— 去 **[桌面版下载页](https://github.com/exfer-stack/exfer-walletd-desktop/releases/latest)**,
  按你的系统选对应的安装包(Windows 选 `.exe`,Mac 选 `.dmg`)。
- **iPhone** —— 暂时还没有。

---

## 进去之后,几个按钮是干嘛的

第一次打开,**设一个密码**就能用了。

- **收款** —— 这是给别人看的「钱包地址」和二维码。别人扫一下,就能把钱转给你。
- **发送** —— 给别人转账,填上对方地址和金额就行。
- **动态** —— 你的收款、转账记录。
- **设置 → 备份钱包** —— 把你的整个钱包导出成**一个加密文件**(`.vault`)。
  以后换手机、重装、手机丢了,用这个文件 +(导出时设的)密码,就能把钱包找回来。
  > 加了新地址之后,记得再导一次备份,这样新地址也包含进去。

密钥只在你手机上,我们碰不到,所以那个**备份文件和密码请自己保管好**。

---

开发、构建、发布等细节看 [English README](README.md)。
