---
title: How to build a site-to-site IPsec VPN between AWS and a FortiGate
category: networking
tags: aws, fortigate, fortios, ipsec, vpn, bgp, site-to-site
slug: how-to-build-a-site-to-site-ipsec-vpn-between-aws-and-a-fort
---

## Overview

This runbook connects an on-premises FortiGate to an AWS VPC using AWS Site-to-Site VPN. You end up with two route-based IPsec tunnels (AWS always gives you two, terminating in different Availability Zones) with BGP running over both, so routes are exchanged automatically and traffic fails over if one tunnel drops.

Use this when you need private connectivity between a site and a VPC and Direct Connect is overkill or not available yet. Each standard tunnel carries up to 1.25 Gbps.

The FortiGate CLI below uses FortiOS 7.x syntax. The AWS steps use the current VPC console. If you only need a quick lab tunnel, there is a static-routing variant near the end, but use BGP for anything real.

> Already planning several VPCs or accounts? Terminate the VPN on a Transit Gateway instead of a virtual private gateway. See the related article on Transit Gateway design patterns on this wiki. The FortiGate side is identical.

## Prerequisites

- A FortiGate with a **static public IPv4 address** on its WAN interface. If it sits behind a NAT device, you need the NAT device's public IP, and UDP 500 and UDP 4500 forwarded to the FortiGate.
- An existing VPC with at least one subnet, and IAM permissions for VPC/VPN resources. To use the console's **Download configuration** button, your IAM identity also needs `ec2:GetVpnConnectionDeviceTypes` and `ec2:GetVpnConnectionDeviceSampleConfiguration`.
- Non-overlapping address space: the VPC CIDR must not overlap any network behind the FortiGate.
- A private BGP ASN for the FortiGate side (for example `65000`). It must be different from the AWS side ASN, which defaults to `64512`.
- Admin access to the FortiGate CLI (SSH or the GUI CLI console).

## Step 1: Create the customer gateway in AWS

The customer gateway is the AWS record of your FortiGate.

1. Open the VPC console and go to **Customer gateways** > **Create customer gateway**.
2. **Name tag**: something like `cgw-hq-fortigate`.
3. **BGP ASN**: your FortiGate's ASN, for example `65000`.
4. **IP address type**: IPv4. **IP address**: the FortiGate's public WAN IP (or the NAT device's public IP).
5. Choose **Create customer gateway**.

Or from the AWS CLI:

```
aws ec2 create-customer-gateway --type ipsec.1 --bgp-asn 65000 --ip-address <FORTIGATE_PUBLIC_IP>
```

Note the BGP ASN. The FortiGate's BGP config must use exactly this value, and changing it later means recreating the VPN connection.

## Step 2: Create and attach a virtual private gateway

1. Go to **Virtual private gateways** > **Create virtual private gateway**.
2. **Name tag**: for example `vgw-prod-vpc`.
3. **Autonomous System Number (ASN)**: keep **Amazon default ASN** (64512) unless you have a reason to pick a custom one (64512-65534, or 4200000000-4294967294 for 32-bit).
4. Choose **Create virtual private gateway**.
5. Select it, then **Actions** > **Attach to VPC**, choose your VPC, and **Attach to VPC**.

```
aws ec2 create-vpn-gateway --type ipsec.1
```

```
aws ec2 attach-vpn-gateway --vpn-gateway-id <VGW_ID> --vpc-id <VPC_ID>
```

## Step 3: Create the Site-to-Site VPN connection

1. Go to **Site-to-Site VPN connections** > **Create VPN connection**.
2. **Target gateway type**: Virtual private gateway, and select the gateway from step 2.
3. **Customer gateway**: Existing, and select the customer gateway from step 1.
4. **Routing options**: **Dynamic (requires BGP)**.
5. **Local IPv4 network CIDR** and **Remote IPv4 network CIDR**: leave at `0.0.0.0/0`. AWS VPNs are route-based, and these wildcard phase 2 selectors are what the FortiGate config below expects.
6. **Tunnel options** (optional, but recommended): under **Edit tunnel options** for each tunnel, set **IKE versions** to `ikev2` only and remove the weak defaults (DH group 2, SHA1) so a misconfigured peer can't negotiate down to them. A good set is AES256 / SHA2-256 / DH group 14 for both phases. You can also choose your own inside /30 CIDRs from `169.254.0.0/16`. Avoid the reserved blocks `169.254.0.0/30` through `169.254.5.0/30` and `169.254.169.252/30`.
7. Choose **Create VPN connection**. It takes a few minutes to become available.

## Step 4: Download the configuration file

1. Select the VPN connection and choose **Download configuration**.
2. Pick **Vendor**: Fortinet, the platform and the FortiOS version closest to yours, and **IKE version**: ikev2. If nothing matches, choose **Generic**.
3. Choose **Download**.

From the file, record these values for **each** tunnel:

- Outside IP of the virtual private gateway, which goes in `<AWS_TUNNEL1_OUTSIDE_IP>` and `<AWS_TUNNEL2_OUTSIDE_IP>`.
- Pre-shared key, which goes in `<TUNNEL1_PSK>` and `<TUNNEL2_PSK>`.
- Inside IPs. Each tunnel has a /30. AWS uses the first usable address, and the FortiGate uses the second. These go in `<AWS_TUNNEL1_INSIDE_IP>` and `<FGT_TUNNEL1_INSIDE_IP>`, and the same for tunnel 2.
- The AWS BGP ASN (64512 unless you set a custom one).

Treat the file as a starting point. AWS generates it with the minimum proposals (AES128, SHA1, DH group 2), so use the stronger proposals below instead. They must be permitted by the tunnel options you chose in step 3.

## Step 5: Configure the IPsec tunnels on the FortiGate

Phase 1 names double as interface names, so keep them under 15 characters. `aws-tun1` and `aws-tun2` are used below. Replace `wan1` with your WAN interface.

```
config vpn ipsec phase1-interface
    edit "aws-tun1"
        set interface "wan1"
        set ike-version 2
        set peertype any
        set proposal aes256-sha256
        set dhgrp 14
        set keylife 28800
        set remote-gw <AWS_TUNNEL1_OUTSIDE_IP>
        set psksecret <TUNNEL1_PSK>
        set dpd on-idle
        set dpd-retryinterval 10
    next
    edit "aws-tun2"
        set interface "wan1"
        set ike-version 2
        set peertype any
        set proposal aes256-sha256
        set dhgrp 14
        set keylife 28800
        set remote-gw <AWS_TUNNEL2_OUTSIDE_IP>
        set psksecret <TUNNEL2_PSK>
        set dpd on-idle
        set dpd-retryinterval 10
    next
end
```

Phase 2 uses wildcard selectors (the default `0.0.0.0/0` both ways), matching the AWS side. Keep the lifetime at or below the AWS phase 2 lifetime (3600 seconds by default).

```
config vpn ipsec phase2-interface
    edit "aws-tun1-p2"
        set phase1name "aws-tun1"
        set proposal aes256-sha256
        set dhgrp 14
        set pfs enable
        set keylifeseconds 3600
        set auto-negotiate enable
    next
    edit "aws-tun2-p2"
        set phase1name "aws-tun2"
        set proposal aes256-sha256
        set dhgrp 14
        set pfs enable
        set keylifeseconds 3600
        set auto-negotiate enable
    next
end
```

## Step 6: Address the tunnel interfaces and clamp MSS

FortiOS creates a tunnel interface for each phase 1. Give each one its inside IP and point it at the AWS inside IP. The `tcp-mss` value stops TCP sessions from sending packets that will need fragmenting once IPsec overhead is added.

```
config system interface
    edit "aws-tun1"
        set ip <FGT_TUNNEL1_INSIDE_IP> 255.255.255.255
        set remote-ip <AWS_TUNNEL1_INSIDE_IP> 255.255.255.252
        set allowaccess ping
        set tcp-mss 1379
    next
    edit "aws-tun2"
        set ip <FGT_TUNNEL2_INSIDE_IP> 255.255.255.255
        set remote-ip <AWS_TUNNEL2_INSIDE_IP> 255.255.255.252
        set allowaccess ping
        set tcp-mss 1379
    next
end
```

AWS supports an MTU of up to 1446 bytes, but the usable size depends on your cipher. With AES-CBC and SHA2-256 AWS recommends MTU 1438 / MSS 1398, or MTU 1422 / MSS 1382 when NAT-T is in use. An MSS of 1379 is safe for either case.

Put both tunnels in a zone so the firewall policies only need writing once:

```
config system zone
    edit "aws-vpn"
        set interface "aws-tun1" "aws-tun2"
    next
end
```

## Step 7: Configure BGP

Peer with the AWS inside IP on each tunnel and advertise only the on-prem networks the VPC should reach. Each `network` prefix must already exist in the FortiGate routing table (as a connected or static route), or it won't be advertised.

```
config router bgp
    set as 65000
    set router-id <FGT_TUNNEL1_INSIDE_IP>
    config neighbor
        edit "<AWS_TUNNEL1_INSIDE_IP>"
            set remote-as 64512
            set soft-reconfiguration enable
        next
        edit "<AWS_TUNNEL2_INSIDE_IP>"
            set remote-as 64512
            set soft-reconfiguration enable
        next
    end
    config network
        edit 1
            set prefix <ONPREM_NETWORK> <ONPREM_NETMASK>
        next
    end
end
```

Replace `65000` with the customer gateway ASN from step 1, and `64512` with the virtual private gateway ASN if you set a custom one. Add one `network` entry per on-prem subnet.

## Step 8: Firewall policies

Create address objects for the two sides and allow only what you need. The example allows all services. Tighten it to the services you actually use.

```
config firewall address
    edit "aws-vpc"
        set subnet <VPC_CIDR> <VPC_NETMASK>
    next
    edit "onprem-lan"
        set subnet <ONPREM_NETWORK> <ONPREM_NETMASK>
    next
end
config firewall policy
    edit 0
        set name "lan-to-aws"
        set srcintf "internal"
        set dstintf "aws-vpn"
        set srcaddr "onprem-lan"
        set dstaddr "aws-vpc"
        set action accept
        set schedule "always"
        set service "ALL"
        set logtraffic all
    next
    edit 0
        set name "aws-to-lan"
        set srcintf "aws-vpn"
        set dstintf "internal"
        set srcaddr "aws-vpc"
        set dstaddr "onprem-lan"
        set action accept
        set schedule "always"
        set service "ALL"
        set logtraffic all
    next
end
```

Replace `internal` with your LAN interface. `edit 0` creates the policy with the next free ID. Make sure no NAT is enabled on these policies, since the VPC needs to see the real on-prem source addresses.

## Step 9: AWS routing and security groups

1. **Route propagation**: in the VPC console go to **Route tables**, select the route table for the subnets that need on-prem access, open the **Route propagation** tab, choose **Edit route propagation**, tick the virtual private gateway and **Save**. Routes advertised by the FortiGate now appear automatically once BGP is up.
2. **Security groups**: on the instances you need to reach, add inbound rules for the on-prem CIDR on the ports you need (for example SSH, RDP, ICMP for testing).
3. **Network ACLs**: if you use custom NACLs, allow the on-prem CIDR both inbound and outbound, including ephemeral ports.

## Verification

On the FortiGate, check the tunnels are up:

```
get vpn ipsec tunnel summary
```

```
diagnose vpn ike gateway list name aws-tun1
```

If a tunnel isn't up, start it by hand (phase 2 name, then phase 1 name):

```
diagnose vpn tunnel up aws-tun1-p2 aws-tun1
```

Check BGP is established on both tunnels, and what you're sending and receiving:

```
get router info bgp summary
```

```
get router info bgp neighbors <AWS_TUNNEL1_INSIDE_IP> advertised-routes
```

```
get router info bgp neighbors <AWS_TUNNEL1_INSIDE_IP> received-routes
```

```
get router info routing-table bgp
```

You should receive the VPC CIDR from both neighbors.

In the AWS console, under **Site-to-Site VPN connections** > your connection > **Tunnel details**, both tunnels should show **Up** and list the number of BGP routes received. Then confirm the propagated on-prem route appears in the VPC route table.

Finally, test from both directions. Ping an EC2 instance's private IP from a host on the LAN, and ping a LAN host from the instance. Sniffing on the FortiGate confirms which tunnel traffic uses:

```
diagnose sniffer packet any "host <EC2_PRIVATE_IP>" 4 20
```

## Troubleshooting

- **Phase 1 never comes up**: confirm the customer gateway IP in AWS matches the FortiGate's actual public IP (or the NAT IP). Check UDP 500/4500 aren't blocked upstream, and that the PSK has no stray whitespace. Run `diagnose debug application ike -1` then `diagnose debug enable` to watch negotiation, and `diagnose debug disable` when done.
- **"No proposal chosen"**: the FortiGate's proposal or DH group isn't in the tunnel's allowed list on the AWS side. Compare step 3's tunnel options with the phase 1/phase 2 `proposal` and `dhgrp`.
- **Tunnels up, BGP stuck in Active or Connect**: check the tunnel interface `ip`/`remote-ip` match the downloaded config exactly, and the FortiGate ASN matches the customer gateway's BGP ASN. A mismatched ASN means recreating the customer gateway and VPN connection.
- **BGP up but the VPC can't reach on-prem**: the on-prem prefix isn't being advertised (it must exist in the FortiGate routing table), route propagation isn't enabled on the right route table, or a security group/NACL is blocking it.
- **Large transfers hang, small pings work**: classic MTU/MSS. Confirm `tcp-mss` is set on both tunnel interfaces, and test with `ping -M do -s 1372 <EC2_PRIVATE_IP>` from a Linux host, lowering the size until it passes.
- **Asymmetric traffic dropped**: AWS sends return traffic over its preferred tunnel, which may differ from the one the FortiGate used. That's expected and both tunnels are in the same zone, so it works as long as both tunnels are up and both have a matching policy.
- **One tunnel shows down in AWS but the FortiGate doesn't initiate**: AWS's default startup action is `Add`, meaning your side must start negotiation. `auto-negotiate enable` on phase 2 handles this. Also check DPD is enabled, so dead SAs get cleared.
- **Tunnels flap around rekey**: keep FortiGate lifetimes at or below the AWS phase 1 (28,800s) and phase 2 (3,600s) lifetimes.

## Static routing variant (lab use)

If you choose **Static** routing on the VPN connection, enter your on-prem CIDR as a static IP prefix in AWS. Skip the BGP section and the tunnel interface addressing, and add static routes on the FortiGate instead:

```
config router static
    edit 0
        set dst <VPC_CIDR> <VPC_NETMASK>
        set device "aws-tun1"
    next
    edit 0
        set dst <VPC_CIDR> <VPC_NETMASK>
        set device "aws-tun2"
        set priority 10
    next
end
```

The second route with a higher priority value acts as a backup. Without BGP, failover depends on DPD tearing the dead tunnel down, so it is slower and less reliable.

## References

- [AWS: Get started with AWS Site-to-Site VPN](https://docs.aws.amazon.com/vpn/latest/s2svpn/SetUpVPNConnections.html)
- [AWS: Configure tunnel options for Site-to-Site VPN](https://docs.aws.amazon.com/vpn/latest/s2svpn/tunnel-configure.html)
- [AWS: Tunnel options and redundancy](https://docs.aws.amazon.com/vpn/latest/s2svpn/VPNTunnels.html)
- [AWS: Best practices for a customer gateway device (MTU/MSS table)](https://docs.aws.amazon.com/vpn/latest/s2svpn/cgw-best-practice.html)
- [Fortinet: IKEv2 IPsec site-to-site VPN to an AWS VPN gateway (BGP example)](https://docs.fortinet.com/document/fortigate/6.2.0/cookbook/31670/ikev2-ipsec-site-to-site-vpn-to-an-aws-vpn-gateway)
- [Fortinet: Connecting a local FortiGate to an AWS VPC VPN (static example)](https://docs.fortinet.com/document/fortigate-public-cloud/7.6.0/aws-administration-guide/506140/connecting-a-local-fortigate-to-an-aws-vpc-vpn)
