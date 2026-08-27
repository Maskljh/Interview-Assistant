面知：求职者全流程模拟面试Agent【五班四组-全栈项目】
# 0.项目概述

面知是一款面向 C 端求职者的全流程模拟面试 Agent，**以 Web 形态提供“准备—面试—复盘—进步追踪”的面试场景闭环训练服务，**实现面试可定制、过程可仿真、历史可复盘、进步可感知。

|||
|---|---|
|**产品形态**<br>|Web<br>|
|**目标用户**<br>|正在准备校招/社招面试的C端用户<br>|
|**核心流程**<br>|1. 题库搭建：由大模型基于岗位要求推理生成问题，并支持用户导入真实面经、题目与知识点<br>
1. 视频多轮面试：AI 面试官根据回答质量、简历经历与岗位胜任力动态追问，同时在用户授权下捕捉视频中的表情与行为信号<br>
1. 面试总结：输出题目、回答、追问链、能力维度评分及可执行改进建议<br>
1. 历史复盘：沉淀不同公司、岗位的问答记录和总结，建立跨场次关联记忆，直观呈现用户的成长<br>
|
|**项目成员**<br>|杨沁瑜（产品） 魏国昊（后端） 罗杰豪（前端）<br>|

# 1.项目背景

## 1.1求职面试现状

近年来线上招聘已逐渐成为用人单位主流的招聘形式，根据艾瑞公司提供的报告，网络招聘仍是企业的主要招聘渠道，社交媒体平台则正成为补充性的求职与招聘渠道。

与此同时，随着就业竞争不断加剧，候选者们在在面试准备阶段花费的时间也越来越多。在各大互联网社交媒体（如小红书、牛客、脉脉）上，各种企业各种岗位的面经分享和讨论层出不穷，由此可以看出，为了拿到心仪offer，候选者们在面试前对模拟面试的意愿正不断加强。

## 1.2模拟面试产品痛点

目前面向C端用户的模拟面试产品以AI语音多轮对话形式为主，根据用户提供的岗位信息和个人简历，利用LLM进行个性化提问，并提供答题思路，但这样的方式存在两个主要问题：一是问题来源仅来自大模型推理，不能运用现有的真实面经；二是缺少复盘机制，现有产品多通过简单的多轮对话完成面试，每面试一次就开启一个新对话窗口，整场面试结束后，用户也不知道自己答得好不好、为什么答得不好、下一次该如何进步，而发现自己的不足、在练习中有所进步恰恰才是模拟面试的核心目的。

## 1.3本项目定位

基于上述分析，本项目定位为面向 C 端求职者的全流程模拟面试 Agent。结合 WPS 云文档、会议和日历等能力，根据用户简历、目标岗位、JD 和历史练习记录，自主规划面试流程、动态追问，并在面试后生成总结与下一轮训练建议，保存当场面试问答记录，帮助用户持续积累面试资料、定位能力短板、验证改进效果，为候选者提供全链路可闭环的模拟面试服务。

# 2.竞品分析

面试场景的产品分为2C和2B两类，2C产品面向求职者，向其提供Agent 式模拟面试能力；2B产品面向企业，多用于企业面试官对求职者的筛选。本项目虽然以C端求职者为目标用户进行设计，但市场上2B类产品的多轮对话、语音交互、情景角色扮演等能力依然值得参考。

## 2.1 2C产品

### 2.1.1 内部产品：WPS AI面试准备

||||
|---|---|---|
|**产品形态**<br>|WPS Office移动端及桌面客户端均支持<br>![picture](https://weboffice-temporary.ks3-cn-beijing.wpscdn.cn/thumbnail/tcQZM6je1rinRHYvszevp5r_100.jpeg?Expires=1787770800&KSSAccessKeyId=AKLTmoJhggaFT1CHuozGZqbC&Signature=yiA1%2B62laXbaBKlxGu0XjMkasUM%3D&response-cache-control=public%2Cmax-age%3D86400)"a.移动端界面"![picture](https://weboffice-temporary.ks3-cn-beijing.wpscdn.cn/thumbnail/t2e7g956Ptnvrofkurc9DAt_100.png?Expires=1787770800&KSSAccessKeyId=AKLTmoJhggaFT1CHuozGZqbC&Signature=HTGQBR6ittynuQpRlSbvh8XkzTs%3D&response-cache-control=public%2Cmax-age%3D86400)"b.桌面客户端界面"|<br>|
|**功能使用路径**<br>|1.功能入口<br>* 移动端：WPS主页-服务-求职与校园-WPS AI简历<br>
* 桌面客户端：WPS主页-稻壳AI-模板资源（简历）-选择使用某一模板-AI面试准备<br>
2\.导入简历<br>* 支持新建简历/导入简历，支持从微信、QQ、本地和WPS账号文件（文字/PDF）导入<br>
* 导入后原有简历内容将填入AI面试准备内置模板，不以原文件样式继续<br>
* 简历内容完整后可使用AI面试稿和AI面试观战两个功能<br>
3\.退出功能<br>* 本轮简历保存地址为我的云文档/应用/简历助手<br>
* 文档为resh文档<br>
|<br>|
|**核心功能拆解**<br>|【AI面试稿】<br>* 生成模式<br>
    * 一键模式：AI自动生成<br>
    * 精准模式：用户通过文字/图片上传岗位描述，再通过AI生成<br>
* 生成内容（以每段工作经历为锚点）<br>
    * 高频问题<br>
    * 回答思路<br>
    * 追问预测<br>
* 生成的内容可复制或导出为word文档，保存地址：我的云文档/应用/简历助手<br>
|![picture](https://weboffice-temporary.ks3-cn-beijing.wpscdn.cn/thumbnail/tccY9zTwRSq1unD2L3Jyq99_100.png?Expires=1787770800&KSSAccessKeyId=AKLTmoJhggaFT1CHuozGZqbC&Signature=mLFbwavGE0zibCX7Ucu%2Fo4VicS8%3D&response-cache-control=public%2Cmax-age%3D86400)"a.一键生成模式"![picture](https://weboffice-temporary.ks3-cn-beijing.wpscdn.cn/thumbnail/trKquFeCXNnisU3MyG3Pr5w_100.png?Expires=1787770800&KSSAccessKeyId=AKLTmoJhggaFT1CHuozGZqbC&Signature=INiY9SccQrXXI3Qf5m29FlPpsig%3D&response-cache-control=public%2Cmax-age%3D86400)"b.精准生成模式"![picture](https://weboffice-temporary.ks3-cn-beijing.wpscdn.cn/thumbnail/tHwU7CEZxLdATCoSbTwFbAS_100.png?Expires=1787770800&KSSAccessKeyId=AKLTmoJhggaFT1CHuozGZqbC&Signature=P4OSigoW7beaqODJhvKuP%2FFv544%3D&response-cache-control=public%2Cmax-age%3D86400)"c.生成内容"|
|<br>|【AI面试观战】<br>* 选择面试官角色（业务面/HR面/BOSS面）<br>
* 选择面试难易度（三种模式+人物、企业、岗位+自定义需求设定）<br>
* AI根据输入信息生成面试问答，以文字+语音方式展现<br>
|![picture](https://weboffice-temporary.ks3-cn-beijing.wpscdn.cn/thumbnail/tBQ9yw5ey1b6zStPS9zM6Z6_100.png?Expires=1787770800&KSSAccessKeyId=AKLTmoJhggaFT1CHuozGZqbC&Signature=fYnBWGDUb5sVm6WXKXIfNceapBw%3D&response-cache-control=public%2Cmax-age%3D86400)"a.面试难易度模式"![picture](https://weboffice-temporary.ks3-cn-beijing.wpscdn.cn/thumbnail/toE8JxEixrKcbKKJemKVTxL_100.png?Expires=1787770800&KSSAccessKeyId=AKLTmoJhggaFT1CHuozGZqbC&Signature=2wrI1yRN4oOAS8FsNMiBMmEW1eQ%3D&response-cache-control=public%2Cmax-age%3D86400)"b.面试高级设置"![picture](https://weboffice-temporary.ks3-cn-beijing.wpscdn.cn/thumbnail/taCbUHajowvTJ3W4ZoTe2cQ_100.png?Expires=1787770800&KSSAccessKeyId=AKLTmoJhggaFT1CHuozGZqbC&Signature=QcC%2FvKqfDvjk4ZV7JG8vEzboBqc%3D&response-cache-control=public%2Cmax-age%3D86400)"c.生成内容"|
|**优劣势分析**<br>|优势：面试准备场景进一步细化<br>* 按意愿强度分为仅提供面试题和面试过程全模拟<br>
* 面试类型、企业风格、面试官人设均可定制<br>
劣势：整个过程仅停留在书面，求职者对实时1v1面试无感知，对于面试准备而言，如何在交流的当下准确表达，并发现不足加以改进，比记住答案内容更重要<br>|<br>|

### 2.1.2外部产品：豆包/BOSS直聘

|||||||
|---|---|---|---|---|---|
|**产品名称**<br>|**产品形态**<br>|**核心场景**<br>|**核心功能流程**<br>|**技术实现**<br>|**不足**<br>|
|豆包<br>|APP<br>![picture](https://weboffice-temporary.ks3-cn-beijing.wpscdn.cn/thumbnail/toYRec2SsZYF9iRbcjpfYsU_100.jpeg?Expires=1787770800&KSSAccessKeyId=AKLTmoJhggaFT1CHuozGZqbC&Signature=zEmT3GNp52JUfd%2FUrIedd%2FnpTeE%3D&response-cache-control=public%2Cmax-age%3D86400)|根据用户提供的岗位信息和个人简历，以语音对话形式进行模拟面试，并提供整场面试报告<br>|1. 上传简历（图像/语音描述）<br>
1. 上传岗位信息（图像/语音描述）<br>
1. 根据上传信息进行面试准备<br>
1. 多轮语音对话<br>
1. 输出整场面试总结报告<br>
|* 面试流程搭建：Prompt<br>
* 简历解析：OCR<br>
* 语音输入：流式 ASR<br>
* 题库搭建：LLM<br>
* 多轮对话：流式 ASR语音输入-LLM推理-TTS语音输出<br>
|1. 产品形态是APP附属功能，非垂直产品<br>
1. 题目仅来自大模型推理，无真实题库<br>
1. 追问策略依赖 Prompt 工程，缺少自主规划能力<br>
1. 多场面试间无关联记忆，用户对个人进步感知弱<br>
|
|BOSS直聘<br>|APP<br>![picture](https://weboffice-temporary.ks3-cn-beijing.wpscdn.cn/thumbnail/t37aduYHiEHgj2R1N4aLj6f_100.jpeg?Expires=1787770800&KSSAccessKeyId=AKLTmoJhggaFT1CHuozGZqbC&Signature=moOdnot5%2B5aNOwpV2oOrbkuPIzw%3D&response-cache-control=public%2Cmax-age%3D86400)|根据用户选择的岗位和上传的简历，以语音对话形式进行模拟面试，并提供整场面试报告<br>|1. 选择面试岗位<br>
1. 上传个人简历（可选）<br>
1. 多轮语音对话面试<br>
1. 输出整场面试总结报告<br>
|同上<br>|1. 产品形态是APP附属功能，非垂直产品<br>
1. 不支持根据岗位信息进行提问多，多场面试间无关联记忆<br>
1. 轻量问答，没有做到 Agent 式全流程多轮动态追问，语音AI感太重<br>
|

## 2.2 2B产品：牛客/猎聘

||||||
|---|---|---|---|---|
|**产品名称**<br>|**产品形态**<br>|**核心场景**<br>|**产品核心功能流程**<br>|**技术实现**<br>|
|牛客AI 面试<br>|* B 端招聘 SaaS，附带简易 C 端练习入口<br>
* 支持网页、小程序，可对接招聘系统<br>
|批量初筛，依托平台人才库，重点挖掘项目经历与综合素养<br>|1. HR 配置岗位题库<br>
1. 生成面试链接<br>
1. 候选人音视频面试<br>
1. 多轮追问、情景角色扮演<br>
1. 生成评估报告，支持录像回看<br>
|* 多轮对话：招聘垂直LLM，依靠上下文维持对话2语音交互：流式 ASR/TTS，连续语音对话，支持数字人<br>
* 角色扮演：预设冲突场景，可模拟压力面试，灵活度较高<br>
|
|猎聘 Doris AI 面试<br>|* 依B 端 AI 面试系统，求职者仅有少量体验入口，无完整训练功能，<br>
* 支持网页、小程序视频面试<br>
|<br>|1. HR 配置胜任力模型<br>
1. 发起面试邀约<br>
1. 候选人视频面试，简历驱动自适应追问<br>
1. 多模态分析输出面试评价<br>
|* 多轮对话：基于简历实现LLM自适应深度追问<br>
* 语音交互：音视频采集，结合语义与面部行为分析<br>
* 角色扮演：以结构化行为提问为主，动态情景模拟能力较弱<br>
|

## 2.3 分析结论

现有 2C 产品已验证“简历/岗位输入 + 多轮语音面试 + 单场报告”的核心需求，但普遍存在题库来源单一、追问策略较浅、产品非垂直以及跨场面成长不可见的问题；2B 产品则在多轮追问、情景角色扮演和多模态评估方面积累较深。

本项目的差异化方向聚焦于“**C 端长期训练闭环**”：以真实题库与 LLM 推理协同提升题目可信度和个性化；以 Agent 规划替代固定 Prompt 串联，实现围绕简历和回答的动态追问；以视频行为信号、语义质量和表达结构共同服务复盘；以多场面试关联记忆和成长看板，帮助用户把单次反馈转化为下一次可验证的改进。

# 3.项目创新点

1. 双源个性化题库：融合大模型生成与用户导入的真实题目，兼顾岗位匹配度、题目真实性与可追溯性

1. Agent 动态追问：基于简历、JD、回答质量和剩余时长自主规划提问路径，模拟真实面试中的深挖、追问与场景切换

1. 多模态复盘：结合回答内容、表达逻辑和视频行为信号生成改进建议；视频信号仅在用户授权后作为辅助反馈，不用于自动化判断

1. 跨场成长追踪：关联不同场次面试记录，沉淀高频短板与能力变化，形成可持续迭代的个人训练计划

# 4.项目意义

1. 用户价值：将搜题、模拟、复盘与历史记录整合为连续训练闭环，帮助求职者定位短板、验证改进并提升面试准备效率

1. 协作价值：结合 WPS 云文档、表格、日历和消息能力，沉淀简历、面试报告与成长数据，让训练资料可管理、可回顾、可持续推进

1. 实践价值：探索大模型 Agent、实时音视频与多模态分析在个人训练场景中的应用

# 5.技术实现

## **5.1前端技术实现**

### **5.1.1技术选型**

* 框架：React 18 + TypeScript

* 构建：Vite

* UI 组件库：Ant Design

* 状态管理：Zustand（面试会话、用户状态）+ React Query（服务端数据缓存）

* 路由：React Router 

* 样式：Tailwind CSS + CSS Modules

* 音视频：WebRTC（getUserMedia 采集摄像头/麦克风）+ Web Audio API

* 实时通信：原生 WebSocket（对接后端流式 ASR/LLM/TTS）

* 图表：ECharts（能力雷达图、成长趋势、短板分析）

* 请求：Axios（REST API）+ 拦截器统一处理 Token、错误与限流

### **5.1.2核心功能模块实现**

1. **WPS OAuth 登录**：前端跳转 WPS 授权页 → 后端回调换取 Token → 前端存储并注入请求头。

1. **题库模块**：调用后端 REST API 展示「LLM 生成 + 用户导入」双源题目，支持标签筛选、导入文件上传。

1. **视频面试主流程**：

    * 通过 WebRTC采集摄像头/麦克风，本地预览；

    * 通过 **WebSocket** 与后端建立长连接，接收流式 ASR 转写文本、LLM 追问、TTS 音频流并实时渲染；

    * 用户授权后采集视频帧用于行为信号分析（仅前端采集、后端分析，遵循最小化采集原则）；

    * 面试状态（进行中/暂停/剩余时长）通过 WebSocket 推送同步。

1. **报告与成长看板**：面试结束后拉取报告数据，用 ECharts 渲染能力维度雷达图、跨场次成长趋势、高频短板分析。

### **5.1.3与后端通信方式**

* 普通业务：REST API（Axios）

* 实时面试：WebSocket（流式 ASR/LLM/TTS、状态推送）

* 文件上传：简历/面经等通过 REST 上传到后端，由后端转存 OSS

## 5.2后端技术实现

### 5.2.1技术选型

* **语言**：Go 1.26

* **Web 框架**：Gin

* **服务间通信**：gRPC + Protocol Buffers

* **对外接口**：REST API

* **实时通信**：WebSocket

* **数据库**：PostgreSQL

* **缓存与会话**：Redis

* **消息队列**：Kafka

* **对象存储**：OSS

* **AI 接入**：OpenAI Compatible API

* **认证**：WPS OAuth

* **容器化**：Docker

### 5.2.2核心功能模块实现

1. **用户与资料服务**

    * 通过 WPS OAuth 完成用户登录与授权；

    * 支持读取用户 WPS 云文档中的简历、JD、面经等资料；

    * 支持简历、JD 等文件上传，由后端统一存储至 OSS；

    * 对资料进行文本解析和结构化处理，为题库生成和 AI 面试提供上下文。

1. **题库与面试服务**

    * 采用「LLM 生成 + 用户导入」双源题库；

    * 根据用户简历、岗位 JD 和历史资料生成个性化面试题；

    * 管理题目、标签、能力维度及难度等信息；

    * 管理面试 Session、问题、回答和多轮追问关系；

    * Redis 保存实时面试状态，PostgreSQL 持久化完整面试记录。

1. **AI Agent 与实时面试**

    * AI Service 通过 OpenAI Compatible API 接入大模型，并通过统一 Provider 层屏蔽具体模型厂商；

    * 基于 Agent Loop 管理面试上下文，根据简历、JD、用户回答、能力评分和剩余时间动态规划下一步问题；

    * 通过流式 ASR → Agent/LLM → TTS 实现实时语音面试；

    * 通过 WebSocket 向前端持续推送 ASR 转写、LLM 回复、TTS 音频和面试状态；

    * 根据用户授权调用第三方视觉服务进行辅助行为分析。

1. **报告与成长服务**

    * 面试结束后通过 Kafka 异步触发报告生成；

    * 综合面试问题、回答、追问链、能力评分和行为分析生成结构化面试报告；

    * 保存历史面试和能力评分数据，生成跨场次能力趋势和短板分析；

    * 将面试结果通过 WPS 接口异步写入用户指定的云文档。

整体架构如下:

```
flowchart TB
    FE["Web 前端<br/>面试 / 题库 / 报告"]
    GW["API Gateway<br/>Go + Gin<br/><br/>鉴权 / 路由 / 限流<br/>CORS / WebSocket"]

    US["用户与资料服务<br/>User Service<br/><br/>WPS OAuth<br/>云文档<br/>文件管理<br/>OSS"]
    IS["面试与题库服务<br/>Interview Service<br/><br/>简历 / JD / 题库<br/>面试 Session<br/>问答 / 追问链<br/>面试状态"]
    AI["AI 智能服务<br/>AI Service<br/><br/>Agent<br/>LLM<br/>ASR / TTS<br/>视觉分析"]

    RS["报告与成长服务<br/>Report Service<br/><br/>面试报告 / 历史复盘<br/>能力趋势 / 成长分析"]

    PG["PostgreSQL<br/>业务数据"]
    REDIS["Redis<br/>缓存 / 会话状态"]
    KAFKA["Kafka<br/>异步事件"]
    OSS["OSS<br/>简历 / 音频 / 视频 / 文件"]

    FE -->|"REST API / WebSocket"| GW
    GW -->|"gRPC"| US
    GW -->|"gRPC"| IS
    GW -->|"gRPC"| AI

    US --> RS
    IS --> RS
    AI --> RS

    RS --> PG
    RS --> REDIS
    RS --> KAFKA

    US -.-> OSS

    %% 样式
    classDef frontend fill:#e8f4ff,stroke:#4a90e2,stroke-width:1.5px
    classDef gateway fill:#fff4e5,stroke:#f5a623,stroke-width:1.5px
    classDef service fill:#f3e8ff,stroke:#8e44ad,stroke-width:1.5px
    classDef storage fill:#eaf7ea,stroke:#4caf50,stroke-width:1.5px

    class FE frontend
    class GW gateway
    class US,IS,AI,RS service
    class PG,REDIS,KAFKA,OSS storage
```

# 6.业务流程图

![processon](https://weboffice-temporary.ks3-cn-beijing.wpscdn.cn/thumbnail/tke3bkGafzYfVBkbzrRTKPP_100.png?Expires=1787770800&KSSAccessKeyId=AKLTmoJhggaFT1CHuozGZqbC&Signature=zd1kJbta%2FtmWc9KBXRGCaOI6dJA%3D&response-cache-control=public%2Cmax-age%3D86400)# 7.进度规划

议总工期：6 周（3 人并行开发）。前 4 周完成核心 MVP，第 5 周集中联调与测试，第 6 周完成优化、部署与答辩交付。微表情/行为信号采用成熟视觉能力进行辅助分析，不纳入自研模型训练范围。

* W1需求与基础框架：明确 MVP、原型、技术选型、数据库与接口设计；完成登录、简历/JD 录入、基础数据模型与评分维度

* W2 题库与面试准备：实现“大模型生成 + 用户导入”的双源题库、简历/JD 解析、题目标签化与面试计划

* W3多轮面试 MVP：完成 Agent 状态管理、动态追问、ASR/TTS 或文本对话链路，以及单场面试记录

* W4视频与复盘闭环：接入 WebRTC 音视频、行为信号辅助、面试报告、历史记录与成长趋势看板

* W5联调与测试：开展功能、兼容性、异常流程和隐私授权测试，优化流式响应、错误提示与数据管理

* W6交付与答辩：部署演示环境，修复遗留问题，完善项目文档、演示脚本、测试报告和答辩材料