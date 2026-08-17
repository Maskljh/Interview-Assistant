import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.interviewassistant.app',
  appName: '模拟面试助手',
  webDir: 'dist',
  server: {
    // App 内需请求 http://<电脑局域网IP>:8080 的后端：
    // Capacitor 默认 WebView origin 是 https://localhost，http 请求会被
    // mixed-content 策略拦截（登录/注册静默失败）。cleartext: true 让
    // origin 变为 http://localhost 并允许明文流量。
    cleartext: true,
  },
};

export default config;
