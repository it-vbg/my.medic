import type { Metadata } from "next";
import "@fontsource-variable/manrope";
import "./globals.css";

export const metadata: Metadata = {
  title: "my.medic — Семейный медицинский кабинет",
  description: "Личные и семейные медицинские карты, анализы и обследования.",
  robots: { index: false, follow: false },
};

export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru"><body>{children}</body></html>;
}
