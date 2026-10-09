import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/theme-provider";
import { ProjectProvider } from "@/lib/use-projects";
import { ApiTokenGate } from "@/components/api-token-gate";
import dynamic from "next/dynamic";
import "./globals.css";

const ManagedShell = dynamic(() => import("@/components/multitenant-shell").then(module => module.ManagedShell));

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "K-Dense BYOK",
  description: "Multi-agent research assistant",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          {process.env.NEXT_PUBLIC_KADY_MULTI_TENANT === "1" ? <ManagedShell>
            <TooltipProvider delayDuration={350}>{children}</TooltipProvider>
          </ManagedShell> : <ProjectProvider>
            <TooltipProvider delayDuration={350}>{children}</TooltipProvider>
          </ProjectProvider>}
          <Toaster />
          {process.env.NEXT_PUBLIC_KADY_MULTI_TENANT !== "1" ? <ApiTokenGate /> : null}
        </ThemeProvider>
      </body>
    </html>
  );
}
