import { randomUUID } from "node:crypto";
import type { GithubConnectionStorage, GithubProfile, GithubSecret, GithubSecretUpdate } from "#github/connections/types.ts";
export class MemoryStore implements GithubConnectionStorage {
  profiles = new Map<string, GithubProfile>();
  secrets = new Map<string, GithubSecret>();
  defaults = new Map<string, string>();
  legacyProjects = new Set<string>();
  globalDefault?: string;
  preferredGlobal?: string;
  epochs = new Map<string, string>();
  async listProfiles() { return [...this.profiles.values()]; }
  async getProfile(id: string) { return this.profiles.get(id); }
  async saveProfile(profile: GithubProfile, secret?: GithubSecret) {
    this.profiles.set(profile.id, profile); if (secret) this.secrets.set(profile.id, secret);
    this.epochs.set(profile.id, randomUUID());
  }
  async removeProfile(id: string) {
    this.profiles.delete(id); this.secrets.delete(id); this.epochs.delete(id);
    if (this.globalDefault === id) this.globalDefault = undefined;
    for (const [project, selected] of this.defaults) if (selected === id) this.defaults.delete(project);
  }
  async snapshotRemoval(id: string) {
    const profile = this.profiles.get(id);
    return profile ? { profile: structuredClone(profile), epoch: this.epochs.get(id) ?? "legacy" } : undefined;
  }
  async removeProfileIfUnchanged(id: string, epoch: string) {
    if (!this.profiles.has(id) || (this.epochs.get(id) ?? "legacy") !== epoch) return false;
    await this.removeProfile(id);
    return true;
  }
  async getGlobalDefault() { return this.globalDefault; }
  async getGlobalDefaultChoice() { return { id: this.globalDefault, preferred: this.globalDefault !== undefined && this.preferredGlobal === this.globalDefault }; }
  async setGlobalDefaultForNewSessions(id: string) {
    await this.setGlobalDefault(id);
    this.preferredGlobal = id;
  }
  async setGlobalDefault(id: string | undefined) {
    if (id !== undefined && !this.profiles.has(id)) throw new Error("GH_CONNECTION_NOT_FOUND");
    this.globalDefault = id;
    this.preferredGlobal = undefined;
  }
  async getProjectDefault(project: string) { return this.defaults.get(project); }
  async ensureLegacyDefault(project: string, load: () => Promise<Extract<GithubProfile, { kind: "app" }> | undefined>) {
    const selected = this.defaults.get(project);
    if (selected || this.legacyProjects.has(project)) return selected;
    this.legacyProjects.add(project);
    const profile = await load();
    if (profile) { this.profiles.set(profile.id, profile); this.defaults.set(project, profile.id); }
    return profile?.id;
  }
  async setProjectDefault(project: string, id: string | undefined) {
    if (id) this.defaults.set(project, id); else this.defaults.delete(project);
  }
  async withSecret<T>(id: string, update: (current: GithubSecret | undefined) => Promise<GithubSecretUpdate<T>>) {
    if (!this.profiles.has(id)) throw new Error("GH_CONNECTION_MISSING");
    const previous = JSON.stringify(this.secrets.get(id));
    const result = await update(this.secrets.get(id));
    if (result.secret) this.secrets.set(id, result.secret); else this.secrets.delete(id);
    if (previous !== JSON.stringify(result.secret)) this.epochs.set(id, randomUUID());
    return result.value;
  }
}
