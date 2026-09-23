import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "SmartFan IoT — Monitoring & Remote Control",
  description: "Web-based IoT platform for monitoring ESP8266-connected smart fans: real-time temperature & humidity, online/offline status, fan ON/OFF remote control, sensor history, and device health.",
  keywords: ["IoT", "Smart Fan", "ESP8266", "Monitoring", "Remote Control", "Temperature", "Humidity", "Next.js", "Dashboard"],
  authors: [{ name: "SmartFan IoT" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "SmartFan IoT — Monitoring & Remote Control",
    description: "Real-time IoT dashboard for smart fan monitoring and remote control via ESP8266.",
    siteName: "SmartFan IoT",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "SmartFan IoT",
    description: "Real-time IoT dashboard for smart fan monitoring and remote control via ESP8266.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
