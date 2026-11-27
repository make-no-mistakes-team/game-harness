export const FABRIC_CLIENT_MINECRAFT = "1.21.4";
export const FABRIC_CLIENT_LOADER = "0.16.10";
export const FABRIC_CLIENT_MAVEN = "https://maven.fabricmc.net/";

// Minecraft 1.21.4 / Loader 0.16.10 client profile:
// https://meta.fabricmc.net/v2/versions/loader/1.21.4/0.16.10/profile/json
// In profile order: Maven group, artifact, version, SHA-256. Fabric Maven publishes
// the SHA-256 sidecars for intermediary and fabric-loader, which the profile omits.
export const FABRIC_CLIENT_LIBRARIES = [
  ["org.ow2.asm", "asm", "9.7.1", "8cadd43ac5eb6d09de05faecca38b917a040bb9139c7edeb4cc81c740b713281"],
  ["org.ow2.asm", "asm-analysis", "9.7.1", "85b29371884ba31bb76edf22323c2c24e172c3267a67152eba3d1ccc2e041ef2"],
  ["org.ow2.asm", "asm-commons", "9.7.1", "9a579b54d292ad9be171d4313fd4739c635592c2b5ac3a459bbd1049cddec6a0"],
  ["org.ow2.asm", "asm-tree", "9.7.1", "9929881f59eb6b840e86d54570c77b59ce721d104e6dfd7a40978991c2d3b41f"],
  ["org.ow2.asm", "asm-util", "9.7.1", "f885be71b5c90556f5f1ad1c4f9276b29b96057c497d46666fe4ddbec3cb43c6"],
  ["net.fabricmc", "sponge-mixin", "0.15.4+mixin.0.8.7", "4631f67da980ae2ac9e6e285a7df4680645e2f37a6a14acc775f97982162c2a2"],
  ["net.fabricmc", "intermediary", FABRIC_CLIENT_MINECRAFT, "6aea9971d72e14f03f2c167ee2c24edd5eb0a59fc3eaedcbdf5c2ad0f0c36786"],
  ["net.fabricmc", "fabric-loader", FABRIC_CLIENT_LOADER, "23557a7d6da3db971a6f9620cb62e7b6e6d1509f5138ebb87529877d2400e568"],
] as const;
