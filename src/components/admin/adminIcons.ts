/**
 * The icon each registry section draws with.
 *
 * Resolved here rather than in the registry: the registry names an icon so it
 * can be read by a test, or by anything else, without pulling in an icon set.
 * Both the overview cards and the navigation resolve through this one map, so
 * a section cannot be drawn with one icon in the sidebar and another on its
 * card.
 */
import {
  Activity,
  Bug,
  Database,
  DatabaseZap,
  Download,
  FileVideo,
  HardDrive,
  Headphones,
  HeartPulse,
  Images,
  Languages,
  Lightbulb,
  ListOrdered,
  PanelsTopLeft,
  Plug,
  Save,
  ServerCog,
  ShieldAlert,
  Subtitles,
  Target,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { AdminIconName } from "../../lib/adminSections";

export const ADMIN_ICONS: Record<AdminIconName, LucideIcon> = {
  activity: Activity,
  bug: Bug,
  database: Database,
  databaseZap: DatabaseZap,
  download: Download,
  fileVideo: FileVideo,
  hardDrive: HardDrive,
  headphones: Headphones,
  heartPulse: HeartPulse,
  images: Images,
  languages: Languages,
  lightbulb: Lightbulb,
  listOrdered: ListOrdered,
  panelsTopLeft: PanelsTopLeft,
  plug: Plug,
  save: Save,
  serverCog: ServerCog,
  shieldAlert: ShieldAlert,
  subtitles: Subtitles,
  target: Target,
  users: Users,
};
