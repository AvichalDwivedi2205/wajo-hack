import { BlockList, isIP } from "node:net";

export function trustedProxyCheck(addresses: string[]) {
  const allowed = new BlockList();
  for (const address of addresses)
    allowed.addAddress(address, isIP(address) === 6 ? "ipv6" : "ipv4");
  return (peer: string | undefined) =>
    !!peer &&
    !!isIP(peer) &&
    allowed.check(peer, isIP(peer) === 6 ? "ipv6" : "ipv4");
}
