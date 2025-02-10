import {BattleNet, Region} from "../lib/battlenet";
import { parseArgs } from 'util';
// NB: a bnet token lasts (almost) exactly one day
// https://github.com/phanx-wow/LibRealmInfo/blob/master/LibRealmInfo.lua nice reference

function removeOutliers(priceObj) {
    let prices = Object.keys(priceObj).map(Number);
    if (prices.length < 4) return priceObj;

    prices.sort((a, b) => a - b);
    let q1 = prices[Math.floor(prices.length * 0.25)];
    let q3 = prices[Math.floor(prices.length * 0.75)];

    let iqr = q3 - q1;

    let lowerBound = q1 - (1.5 * iqr);
    let upperBound = q3 + (1.5 * iqr);

    return Object.fromEntries(
        Object.entries(priceObj).filter(([k, v]) => {
            let price = Number(k);
            return price >= lowerBound && price <= upperBound;
        })
    );
}

const { values, positionals } = parseArgs({
    args: Bun.argv,
    options: {
        realm: {
            type: 'string'
        },
        region: {
            type: 'string'
        },
        outfile: {
            type: 'string'
        }
    },
    strict: true,
    allowPositionals: true
});

const opts = ['realm', 'region', 'outfile'];
let missingOpts = [];

for (const opt of opts) {
    if (!Object.keys(values).includes(opt)) missingOpts.push(opt);
}

if (missingOpts.length) {
    console.log(`Correct usage: bun run cli/download --region [eu/us/kr/cn/tw] --realm "<realm name>" --outfile "/path/to/Addons/OpenTradeSkill_Pricing/PriceData.lua"`);
    console.log(`Missing options: ${missingOpts.join(', ')}`);
    process.exit(1);
}

(async () => {

    const cacheFile = Bun.file('.cache/realms.json');

    const regionName = values.region.toLowerCase();
    const realmName = values.realm.toLowerCase();
    const outFile = Bun.file(values.outfile.endsWith('/PriceData.lua') ? values.outfile : values.outfile + '/PriceData.lua');

    const bnet = new BattleNet(process.env.BNET_CLIENT_ID, process.env.BNET_CLIENT_SECRET);

    // get cached realm data if it exists
    let realmCache = {};
    if (await cacheFile.exists()) {
        realmCache = await cacheFile.json();
    }

    let cacheKey = `${regionName}:${realmName}`;
    let connectedRealmId = -1;
    let physicalRealmId = -1;
    if (!realmCache.hasOwnProperty(cacheKey)) {
        const realms = (await bnet.getConnectedRealms(regionName)).connectedRealms;

        for (const realm of realms) {
            let realmInfo = await bnet.getConnectedRealmInformation(regionName, realm);
            let validRealms = realmInfo.realms.filter(r => r.name.toLowerCase() === realmName);
            if (validRealms.length) {
                if (validRealms.length > 1) {
                    console.log(`Somehow found multiple realms for '${regionName}:${realmName}'.`);
                    console.log(`Please make an issue on Github: https://github.com/opentradeskill/price-db`);
                    process.exit(1);
                }
                else {
                    connectedRealmId = realm;
                    physicalRealmId = validRealms[0].id;

                    realmCache[cacheKey] = {
                        connectedRealmId: connectedRealmId,
                        physicalRealmId: physicalRealmId,
                    };

                    await Bun.write('.cache/realms.json', JSON.stringify(realmCache));
                    break;
                }
            }
        }
    }
    else {
        connectedRealmId = Number(realmCache[cacheKey].connectedRealmId);
        physicalRealmId = Number(realmCache[cacheKey].physicalRealmId);
    }

    if (physicalRealmId === -1 || connectedRealmId === -1) {
        console.log(`Invalid values for ${cacheKey}: (connectedRealmId: ${connectedRealmId}, physicalRealmId: ${physicalRealmId})`);
        console.log(`If you know the connected and physical realm IDs, you can add it to '.cache/realms.json':`);
        console.log({
            [cacheKey]: {
                physicalRealmId: 123,
                connectedRealmId: 456
            }
        });
        process.exit(1);
    }

    console.log(`Downloading auction data for ${cacheKey}: (connectedRealmId: ${connectedRealmId}, physicalRealmId: ${physicalRealmId})`)

    let auctions = (await bnet.getConnectedRealmAuctions(regionName, connectedRealmId)).auctions;
    auctions = auctions.concat(
        (await bnet.getConnectedRealmCommodities(regionName)).auctions
    );
    let auctionsCounted = [];

    let auctionData = {};

    // map data so that it's in the format of itemId => [ lowest = xyz, prices = [ price1 => qty, price2 => qty ... ] ]
    for (const auction of auctions) {
        if (auctionsCounted.includes(auction.auctionId)) continue;

        if (auctionData.hasOwnProperty(auction.itemId)) {
            if (auctionData[auction.itemId].hasOwnProperty(auction.buyout.raw)) {
                auctionData[auction.itemId].prices[auction.buyout.raw] += auction.quantity;
            }
            else {
                if (auction.buyout.raw < auctionData[auction.itemId].lowest) {
                    auctionData[auction.itemId].lowest = auction.buyout.raw;
                }
                auctionData[auction.itemId].prices[auction.buyout.raw] = auction.quantity;
            }
        }
        else {
            auctionData[auction.itemId] = {
                lowest: auction.buyout.raw,
                prices: {}
            };
            auctionData[auction.itemId][auction.buyout.raw] = auction.quantity;
        }

        auctionsCounted.push(auction.auctionId);
    }

    // now remove all outliers where possible
    for (const itemId of Object.keys(auctionData)) {
        let removedOutliers = removeOutliers(auctionData[itemId].prices);
        if (auctionData[itemId].prices.length === removedOutliers.length) continue;

        let lowest = Object.keys(removedOutliers).sort((a, b) => a - b)[0];
        auctionData[itemId].lowest = lowest;
    }

    // some random test items :p
    console.log(`rousing ire: ${JSON.stringify(auctionData[190451])}`); // exp: 600000
    console.log(`dockyard dagger: ${JSON.stringify(auctionData[159521])}`); // exp: 4500
    console.log(`gloom chitin R1: ${JSON.stringify(auctionData[212667])}`); // exp: 11500
    console.log(`gloom chitin R2: ${JSON.stringify(auctionData[212668])}`); // exp: 60700

    // convert to a lua table format
    let luaTableInner = '';
    for (const itemId of Object.keys(auctionData)) {
        luaTableInner += `[${itemId}]=${Number(auctionData[itemId].lowest)},`
    }
    luaTableInner = luaTableInner.slice(0, -1);

    const currentDate = new Date();
    await Bun.write(outFile, `
    -- autogenerated at ${currentDate.toUTCString()}
    local _, ns = ...
    if not ns.Prices then ns.Prices = {} end
    if not ns.Prices[${bnet.regionToId(regionName)}] then ns.Prices[${bnet.regionToId(regionName)}] = {} end
    ns.Prices[${bnet.regionToId(regionName)}][${physicalRealmId}] = {meta={downloaded_at=${Math.floor((currentDate.getTime()) / 1000)}}, prices={${luaTableInner}}}
    `);
})();