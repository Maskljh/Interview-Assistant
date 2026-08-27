import type { InterviewTurn } from '../api/interviews';

/**
 * 追问链演示数据（仅用于答辩/演示）：
 * 当某场面试没有对话记录时，详情页可一键加载本数据展示树形追问链。
 * 内容为一段虚构的后端开发岗位模拟面试，含 2 个主问题与多个追问。
 */
export const DEMO_TURNS: InterviewTurn[] = [
  {
    id: 10001,
    seq: 1,
    role: 'interviewer',
    kind: 'question',
    content: '请先做个自我介绍，重点说明你的技术栈和最有代表性的项目经历。',
    created_at: '2026-08-26T09:00:00Z',
  },
  {
    id: 10002,
    seq: 2,
    role: 'candidate',
    kind: 'answer',
    content:
      '我是一名有 3 年后端开发经验的工程师，主要技术栈是 Go 和 MySQL。最近负责一个订单系统的重构项目，把单体服务拆分成了微服务，并将高频读接口接入 Redis 缓存，QPS 提升了约 3 倍。',
    created_at: '2026-08-26T09:00:10Z',
  },
  {
    id: 10003,
    seq: 3,
    role: 'interviewer',
    kind: 'follow_up',
    content: '你提到用 Redis 做缓存，能具体说说你们的缓存一致性方案是怎么设计的吗？',
    created_at: '2026-08-26T09:00:18Z',
  },
  {
    id: 10004,
    seq: 4,
    role: 'candidate',
    kind: 'answer',
    content:
      '我们采用的是 Cache Aside 模式：读请求先查缓存，未命中再查库并回填；写请求先更新数据库，再删除缓存。这样能在绝大多数场景下保证一致性，同时把缓存雪崩风险控制在一定范围。',
    created_at: '2026-08-26T09:00:26Z',
  },
  {
    id: 10005,
    seq: 5,
    role: 'interviewer',
    kind: 'follow_up',
    content: '如果缓存和数据库出现了短暂不一致，你们是怎么排查和恢复的？',
    created_at: '2026-08-26T09:00:34Z',
  },
  {
    id: 10006,
    seq: 6,
    role: 'candidate',
    kind: 'answer',
    content:
      '我们会先核对 key 的过期策略和删除时机，确认是否是并发写导致。日常通过慢日志和监控告警定位热点 key，必要时对该 key 直接手动失效并触发回源，恢复期间会短暂限制该接口的写频率。',
    created_at: '2026-08-26T09:00:42Z',
  },
  {
    id: 10007,
    seq: 7,
    role: 'interviewer',
    kind: 'question',
    content: '介绍一个你遇到过的最有挑战性的项目，以及你在其中承担的角色。',
    created_at: '2026-08-26T09:01:00Z',
  },
  {
    id: 10008,
    seq: 8,
    role: 'candidate',
    kind: 'answer',
    content:
      '最有挑战的是订单库的水平拆分。我担任核心开发，负责拆库方案设计和数据迁移脚本。需要兼容老订单的查询路径，同时保证迁移过程中业务无感。',
    created_at: '2026-08-26T09:01:08Z',
  },
  {
    id: 10009,
    seq: 9,
    role: 'interviewer',
    kind: 'follow_up',
    content: '数据迁移是这类项目风险最高的环节，你们当时最大的风险是什么，怎么控制的？',
    created_at: '2026-08-26T09:01:16Z',
  },
  {
    id: 10010,
    seq: 10,
    role: 'candidate',
    kind: 'answer',
    content:
      '最大的风险是迁移期间的数据一致性。我们采用双写 + 校验对账的方案：先做全量历史数据迁移，再做增量双写，最后用对账任务对比两边的数据差异，直到差异归零才切换流量。',
    created_at: '2026-08-26T09:01:24Z',
  },
];
