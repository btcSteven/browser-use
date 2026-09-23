# 让 AI 控制你的浏览器做任何事情

browser-use-agent

这是一个装在你 Chrome 浏览器里的 AI 助手，复杂表单的查找和填写、抢票、比价、爬取页面、总结长文、秒杀下单等，说清目标即可，它会分析需求 拆分任务，真正解放你的工作任务，也可以配合你的agent使用。

安装改chrome 插件后， 只需要配置模型 API，即可使用该助手。

基于 [Ember Browser Agent](https://github.com/Wrenbjor/ember-browser) 二次开发。代码是纯 JavaScript，没有构建步骤，二次开发改动很小。



两种用法，共用同一套浏览器能力：


| 用法                      | 谁来想                            | 谁来点                       | 要不要 `npm start` |
| ----------------------- | ------------------------------ | ------------------------- | --------------- |
| **侧边栏任务**               | 侧边栏齿轮里填的模型                     | 扩展在当前 Chrome 里执行          | 不用              |
| **MCP + 本地 / 外部 Agent** | Cursor、Claude Code、Gemini CLI… | 同上，Agent 调 `browser_`* 工具 | 要               |


---



## 你需要什么

- Chrome（或兼容 Chromium 的浏览器）
- 一个会 **tool calling** 的模型（侧边栏）或任意 MCP 客户端（Agent）
- Node.js 20+：只有配合 Cursor、Claude Code 这类外部 Agent 时才要。只用侧边栏可以不装、不跑 `npm start`

```
git clone <本仓库>
cd browser-use
npm install
```

模型在侧边栏齿轮里配置：填写接口地址、API key 和模型名称，点确认后下一次任务就用新模型。填任何会 tool calling、且你的接口能访问的模型。本地也可以，例如 Ollama 的 `http://127.0.0.1:11434/v1`。

---



## 1. 加载扩展

1. 打开 `chrome://extensions`
2. 打开右上角 **开发者模式**
3. **加载已解压的扩展程序** → 选仓库里的 `extension/`
4. 把 **browser-use** 钉到工具栏

点图标会打开侧边栏。只用侧边栏时，到这里就可以发布任务，不必 `npm start`。侧边栏小圆点是灰的也没关系，那只表示 MCP 没连上。

---



## 2. 启动本机桥（仅 MCP，不用本地agent 可不配置）

要让 Cursor、Claude Code、Gemini CLI 操作这个 Chrome 时，再在仓库根目录启动：

```bash
npm start
```

默认端口 `8765`。扩展连上后，工具栏角标出现绿色 **MCP**，侧边栏小圆点变绿。改扩展代码后在 `chrome://extensions` 重新加载。

---



## 3. 用法 A：侧边栏发布任务

这是任务 Agent，不是问答机器人。不启动 `npm start` 也能用：模型请求发往齿轮里填的接口，点击和填写由扩展直接在当前 Chrome 里完成。

1. 打开你要操作的网页，再开侧边栏
2. 发布目标，例如：`订一张武汉到北京的机票`
3. 模型会自己拆步骤、看页面、点选填写，直到做完或页面卡住
4. 执行中按钮是 **终止**，不是发送

约定：

- 还在你打开侧边栏的那个站：继续用当前标签，刷新没问题
- 模型自己决定去另一个站：会开**新标签**，不覆盖你原来的页
- 页面自己跳转（点链接、提交表单）：仍在当前标签
- 你打开侧边栏时的那个标签不会被关掉

模型要会函数调用。纯聊天模型只能说话，点不了页面。部分云厂商模型会按地区返回 403，换一个你能访问的模型即可。

---



## 4. 用法 B：配合本地 / 外部 Agent（MCP）

本地 Agent 当大脑，这个仓库只出手。这一步才需要本机桥。

- 只让 MCP 客户端启动 `mcp-server/server.js`（推荐给 Cursor / Claude Code）
- 或只自己 `npm start`（不要再让另一个进程绑 8765）



### Cursor

用户级或项目级 `mcp.json`：

```json
{
  "mcpServers": {
    "browser-use": {
      "command": "node",
      "args": ["/绝对路径/browser-use/mcp-server/server.js"]
    }
  }
}
```

然后对 Agent 说：用浏览器订一张武汉到北京的机票。

### Claude Code

```bash
claude mcp add browser-use -- node /绝对路径/browser-use/mcp-server/server.js
```



### Gemini CLI / Claude Desktop

```json
{
  "mcpServers": {
    "browser-use": {
      "command": "node",
      "args": ["/绝对路径/browser-use/mcp-server/server.js"]
    }
  }
}
```

---



## 怎么工作的

```
侧边栏 ──模型接口（齿轮里的地址）
   └── chrome.runtime ──► 扩展 background.js ──► content.js ──► 当前 Chrome 标签

MCP 客户端 ──stdio──► mcp-server/server.js
                         └── WebSocket ──► 扩展 background.js ──► content.js ──► 当前 Chrome 标签
```


| 目录                     | 作用                    |
| ---------------------- | --------------------- |
| `extension/`           | Chrome 扩展：后台、内容脚本、侧边栏 |
| `mcp-server/server.js` | 仅外部 Agent 用的本机桥 + MCP |


依赖装在仓库根目录，不要在子目录再 `npm install`。

---



## 常见问题

**只用侧边栏，小圆点是灰的**  
正常。灰点表示没连 MCP。侧边栏任务不依赖 `npm start`。

**要用外部 Agent，但角标没有绿色 MCP**  
先 `npm start`，再重新加载扩展。确认没被别的进程占用 8765。

**侧边栏报 403 / region**  
是上游模型地区限制。在侧边栏齿轮里换一个你能访问的模型，点确认。

**改了扩展界面没变化**  
`chrome://extensions` 里重新加载，关掉侧边栏再打开。

**搜索结果里一排相同按钮被连点**  
同文案列表应只点一次。若第一次点击本身没打开下一页，把侧边栏记录发 issue。

**想停掉正在跑的任务**  
点红色 **终止**。

---



## 许可

上游 Ember 为 MIT。本仓库在其基础上修改。