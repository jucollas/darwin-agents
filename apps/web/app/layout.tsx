import type { Metadata } from "next";
import { Archivo, Fraunces } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/Providers";
import { AccountBar } from "@/components/AccountBar";

const fraunces = Fraunces({
  subsets: ["latin"],
  axes: ["SOFT", "WONK", "opsz"],
  variable: "--font-fraunces",
  display: "swap",
});

const archivo = Archivo({
  subsets: ["latin"],
  variable: "--font-archivo",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Darwin Agents",
  description:
    "A population of marketing agents that compete for a budget, breed when they profit and shut down when they do not — with every spending limit enforced on Ethereum.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={`${fraunces.variable} ${archivo.variable}`}>
        <Providers>
          <AccountBar />
          {children}
        </Providers>
      </body>
    </html>
  );
}
