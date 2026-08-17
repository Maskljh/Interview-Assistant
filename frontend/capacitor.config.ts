import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.interviewassistant.app',
  appName: '模拟面试助手',
  webDir: 'dist',
  server: {
    // App 内需请求 http://<电脑局域网IP>:8080 的后端。Capacitor 8 默认
    // WebView origin 是 https://localhost，请求明文 http 会被 mixed-content
    // 策略拦截（登录/注册静默失败）。androidScheme: "http" 让 origin 变为
    // http://localhost，与后端 CORS 白名单匹配，且 http→http 无拦截。
    androidScheme: 'http',
    cleartext: true,
  },
};

export default config;
