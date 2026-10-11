import type { BuildOptions } from 'esbuild';

export const options: BuildOptions;
export function optionsFor(mode: 'development' | 'production' | 'watch'): BuildOptions;
export function copyStatic(): void;
