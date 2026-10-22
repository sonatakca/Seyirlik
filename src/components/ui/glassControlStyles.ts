export const glassControlBase =
  "inline-flex items-center justify-center rounded-full bg-[rgb(23_23_25/0.75)] text-white/78 shadow-[0_0_0_1px_rgba(255,255,255,0.06),inset_0_1px_0_rgba(255,255,255,0.12),inset_0_-1px_0_rgba(0,0,0,0.3),0_10px_35px_rgba(0,0,0,0.28)] backdrop-blur-2xl transition-[background-color,box-shadow,color,transform,opacity] duration-150 ease-out hover:bg-white/[0.09] hover:text-white hover:shadow-[0_0_0_1px_rgba(255,255,255,0.1),inset_0_1px_0_rgba(255,255,255,0.15),inset_0_-1px_0_rgba(0,0,0,0.24),0_10px_35px_rgba(0,0,0,0.28)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30 active:scale-[0.96]";

export const glassIconButton = `${glassControlBase} h-10 w-10`;

export const glassPillButton = `${glassControlBase} min-h-10 px-4 text-sm font-black`;

export const glassSegmentedToolbar =
  "inline-flex items-center rounded-full bg-[#171719]/75 p-1 shadow-[0_0_0_1px_rgba(255,255,255,0.06),inset_0_1px_0_rgba(255,255,255,0.12),inset_0_-1px_0_rgba(0,0,0,0.3),0_10px_35px_rgba(0,0,0,0.28)] backdrop-blur-2xl";

export const glassSegmentedItem =
  "relative inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-transparent text-white/78 transition-[background-color,color,opacity,transform] duration-150 ease-out hover:bg-white/[0.12] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/30 active:scale-[0.94]";

export const glassSegmentedItemActive = "bg-white/[0.15] text-white shadow-sm";

export const glassInputControl = `${glassControlBase} min-h-12 justify-start px-4 text-sm font-semibold`;
