'use client';

import Image from 'next/image';

// Tiny client island: next/image with a hide-on-error fallback (onError
// handlers can't live in server components).
export default function LogoImage({ size, className }: { size: number; className?: string }) {
  return (
    <Image
      src="/vwing_logo.png"
      alt="NetraOps"
      width={size}
      height={size}
      className={className}
      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
    />
  );
}
