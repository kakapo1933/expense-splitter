const PALETTE = ["#7c3aed", "#db2777", "#0891b2", "#d97706", "#059669", "#dc2626", "#4f46e5", "#0d9488"];

export function avatarColor(index: number): string {
  return PALETTE[index % PALETTE.length]!;
}

export function Avatar({ name, index, size = 26 }: { name: string; index: number; size?: number }) {
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      className="av"
      aria-hidden="true"
      style={{ background: avatarColor(index), width: size, height: size, fontSize: Math.round(size * 0.42) }}
    >
      {initial}
    </span>
  );
}
