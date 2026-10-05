// Small React Native building blocks for the Docket panel. Every color comes
// from the host theme, so the panel works in light and dark themes and on
// mobile.
import type { PluginTheme } from "@getpaseo/plugin";
import type { ReactNode } from "react";
import { Pressable, Text, View, type TextStyle, type ViewStyle } from "react-native";

export interface Kit {
  theme: PluginTheme;
  compact: boolean;
}

type Tone = "primary" | "plain" | "quiet" | "danger";

export function Button({ kit, label, onPress, tone = "plain", disabled, selected }: { kit: Kit; label: string; onPress: () => void; tone?: Tone; disabled?: boolean; selected?: boolean }) {
  const c = kit.theme.colors;
  const background = tone === "primary" ? c.accent : selected ? c.surface2 : c.surface1;
  const color = tone === "primary" ? c.accentForeground : tone === "quiet" ? c.foregroundMuted : tone === "danger" ? c.statusDanger : c.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled, selected: !!selected }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        paddingVertical: kit.compact ? 8 : 6,
        paddingHorizontal: 10,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: selected ? c.accent : c.border,
        backgroundColor: background,
        opacity: disabled ? 0.5 : pressed ? 0.75 : 1,
      })}
    >
      <Text style={{ color, fontSize: 13, fontWeight: tone === "primary" ? "600" : "400" }}>{label}</Text>
    </Pressable>
  );
}

export function Row({ children, gap = 8, style }: { children: ReactNode; gap?: number; style?: ViewStyle }) {
  return <View style={[{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap }, style]}>{children}</View>;
}

export function T({ kit, children, muted, bold, color, size = 14, italic, style, selectable }: { kit: Kit; children: ReactNode; muted?: boolean; bold?: boolean; color?: string; size?: number; italic?: boolean; style?: TextStyle; selectable?: boolean }) {
  const c = kit.theme.colors;
  return (
    <Text selectable={selectable} style={[{ color: color ?? (muted ? c.foregroundMuted : c.foreground), fontSize: size, fontWeight: bold ? "600" : "400", fontStyle: italic ? "italic" : "normal", lineHeight: Math.round(size * 1.4) }, style]}>
      {children}
    </Text>
  );
}

/** A small uppercase section title. */
export function Section({ kit, title, children }: { kit: Kit; title: string; children: ReactNode }) {
  return (
    <View style={{ gap: 6, marginTop: 12 }}>
      <T kit={kit} size={11} bold color={kit.theme.colors.accent} style={{ letterSpacing: 0.8 }}>
        {title.toUpperCase()}
      </T>
      <View style={{ gap: 6, paddingLeft: 8 }}>{children}</View>
    </View>
  );
}

/** A label and value on one line; the value wraps. */
export function Field({ kit, label, value }: { kit: Kit; label: string; value: string }) {
  return (
    <View style={{ flexDirection: "row", gap: 8 }}>
      <T kit={kit} muted size={13} style={{ width: 56 }}>
        {label}
      </T>
      <T kit={kit} size={13} style={{ flex: 1 }} selectable>
        {value}
      </T>
    </View>
  );
}

export function Card({ kit, children }: { kit: Kit; children: ReactNode }) {
  const c = kit.theme.colors;
  return <View style={{ borderWidth: 1, borderColor: c.border, borderRadius: 8, backgroundColor: c.surface1, padding: kit.compact ? 10 : 14, gap: 4 }}>{children}</View>;
}

export function capped(text: unknown, limit: number): string {
  const s = String(text ?? "");
  return s.length > limit ? s.slice(0, limit - 1) + "…" : s;
}
