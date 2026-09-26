import { Archivo } from 'next/font/google';

// The headline face. Its width axis lets the hero set it condensed (see .landing-display).
export const archivo = Archivo({
  subsets: ['latin'],
  axes: ['wdth'],
  variable: '--font-archivo',
});
