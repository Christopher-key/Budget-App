#!/usr/bin/env python3
"""Check Cosmos expiry invariants in compiled ARM JSON; no Azure access required."""
import json
import sys


def validate(template):
    containers = [resource for resource in template.get('resources', [])
                  if resource.get('type', '').lower() ==
                  'microsoft.documentdb/databaseaccounts/sqldatabases/containers']
    if not containers:
        raise ValueError('The compiled template has no Cosmos account container.')
    for container in containers:
        resource = container.get('properties', {}).get('resource', {})
        policy = resource.get('indexingPolicy', {})
        # Azure rejects TTL with indexingMode:none, even when defaultTtl is -1.
        if 'defaultTtl' in resource and policy.get('indexingMode', '').lower() != 'consistent':
            raise ValueError('Cosmos TTL requires consistent indexing.')
        # App records must survive indefinitely; only short-lived rate records
        # opt into automatic deletion by supplying a positive item-level TTL.
        if resource.get('defaultTtl') != -1:
            raise ValueError('Account and budget records must not expire by default.')
        if policy.get('automatic') is not True:
            raise ValueError('System timestamps must be indexed automatically for expiry.')
        included = {entry.get('path') for entry in policy.get('includedPaths', [])}
        excluded = {entry.get('path') for entry in policy.get('excludedPaths', [])}
        if '/_ts/?' not in included:
            raise ValueError('Expiry requires the system timestamp index in this template.')
        if included - {'/_ts/?'} or '/*' not in excluded:
            raise ValueError('Credential and encrypted payload document paths must remain unindexed.')


def main():
    if len(sys.argv) != 2:
        raise SystemExit('Usage: python3 Verification/check-cloud-template.py COMPILED_TEMPLATE.json')
    with open(sys.argv[1], encoding='utf-8') as source:
        template = json.load(source)
    try:
        validate(template)
    except ValueError as error:
        raise SystemExit(str(error))
    print('Cosmos template checks passed: compatible expiry, non-expiring accounts, timestamp-only indexing.')


if __name__ == '__main__':
    main()
