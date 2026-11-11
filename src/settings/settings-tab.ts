// src/settings/settings-tab.ts
import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import type SynologySyncPlugin from '../main';

export class SynologySyncSettingTab extends PluginSettingTab {
  plugin: SynologySyncPlugin;

  constructor(app: App, plugin: SynologySyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName('连接').setHeading();

    new Setting(containerEl)
      .setName('QuickConnect ID')
      .setDesc('群晖 QuickConnect ID，用于外网或手机流量同步。内网可达时会优先走局域网地址。')
      .addText(text => text
        .setPlaceholder('例如 my-nas')
        .setValue(this.plugin.settings.quickConnectId)
        .onChange(async (value) => {
          this.plugin.settings.quickConnectId = value.trim();
          this.plugin.resetActiveSession();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('局域网地址（可选）')
      .setDesc('推荐填写完整协议，例如 https://192.168.1.100:5001。用 http://…:5000 时密码会在局域网内明文传输。')
      .addText(text => text
        .setPlaceholder('https://192.168.1.100:5001')
        .setValue(this.plugin.settings.lanAddress)
        .onChange(async (value) => {
          this.plugin.settings.lanAddress = value.trim();
          this.plugin.resetActiveSession();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('DSM 账号')
      .setDesc('建议使用只对该目录有读写权限的普通账号，不要用管理员账号。')
      .addText(text => text
        .setPlaceholder('your-name')
        .setValue(this.plugin.settings.account)
        .onChange(async (value) => {
          this.plugin.settings.account = value.trim();
          this.plugin.resetActiveSession();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('DSM 密码')
      .setDesc('密码以明文保存在本机插件配置文件 data.json 中，不会上传；请配合 HTTPS 使用。')
      .addText(text => {
        text.inputEl.type = 'password';
        text
          .setPlaceholder('••••••••')
          .setValue(this.plugin.settings.password)
          .onChange(async (value) => {
            this.plugin.settings.password = value;
            this.plugin.resetActiveSession();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('远端目录')
      .setDesc('NAS 上的目标目录，必须写完整路径，例如 /homes/obsidian/Obsidian/vault。不要留默认的 /homes。')
      .addText(text => text
        .setPlaceholder('/homes/用户名/Obsidian/vault')
        .setValue(this.plugin.settings.remotePath)
        .onChange(async (value) => {
          this.plugin.settings.remotePath = value.trim();
          this.plugin.resetActiveSession();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('测试连接')
      .setDesc('先验证 NAS 是否可达、账号密码是否正确，再开始同步。')
      .addButton(btn => btn
        .setButtonText('测试连接')
        .setCta()
        .onClick(async () => {
          btn.setDisabled(true);
          btn.setButtonText('正在测试…');
          try {
            await this.plugin.testConnection();
            new Notice('✓ 已成功连接群晖 NAS');
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            new Notice(`✗ 连接失败：${msg}`);
          } finally {
            btn.setDisabled(false);
            btn.setButtonText('测试连接');
          }
        }));

    new Setting(containerEl).setName('同步').setHeading();

    new Setting(containerEl)
      .setName('启动时自动同步')
      .setDesc('打开 Obsidian 后自动同步一次。')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoSyncOnStartup)
        .onChange(async (value) => {
          this.plugin.settings.autoSyncOnStartup = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('定时同步间隔')
      .setDesc('按间隔自动同步。库比较大时建议 15 分钟以上。')
      .addDropdown(dropdown => dropdown
        .addOption('0', '关闭')
        .addOption('5', '每 5 分钟')
        .addOption('15', '每 15 分钟')
        .addOption('30', '每 30 分钟')
        .setValue(String(this.plugin.settings.syncIntervalMinutes || 0))
        .onChange(async (value) => {
          this.plugin.settings.syncIntervalMinutes = parseInt(value, 10);
          await this.plugin.saveSettings();
          this.plugin.setupSyncInterval();
        }));

    new Setting(containerEl)
      .setName('忽略规则')
      .setDesc('每行一条，支持 *.tmp、目录/**、._* 这类通配写法。建议保留 workspace 与回收站条目。')
      .addTextArea(text => {
        text.inputEl.rows = 8;
        text.inputEl.cols = 40;
        text
          .setPlaceholder(`${this.app.vault.configDir}/**\n${this.app.vault.configDir}/workspace.json\n.trash/**\n*.tmp`)
          .setValue((this.plugin.settings.ignorePatterns || []).join('\n'))
          .onChange(async (value) => {
            this.plugin.settings.ignorePatterns = value
              .split('\n')
              .map(line => line.trim())
              .filter(line => line.length > 0);
            await this.plugin.saveSettings();
          });
      });

    const info = containerEl.createEl('p', { cls: 'setting-item-description' });
    info.setText(
      '说明：冲突时保留两份——本地原文不动，远端版本另存为「文件名 (conflict-syno-时间戳).md」。远端删除是永久删除（除非 NAS 共享文件夹启用了回收站），本地删除走 Obsidian 回收站。'
    );
  }
}
