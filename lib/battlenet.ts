export enum Lifetime {
    Dynamic = 'dynamic',
    Static = 'static'
}

export enum Region {
    Europe = 'eu',
    NorthAmerica = 'us',
    Korea = 'kr',
    Taiwan = 'tw',
    China = 'cn'
}

export interface Namespace {
    lifetime: Lifetime,
    region: Region
}

export class BattleNet {
    private clientId: string;
    private clientSecret: string;
    private locale: string;

    private bearerToken: string|null = null;
    private authExpires: number|null = null;

    constructor(
        clientId: string,
        clientSecret: string,
        locale: string = 'en_US'
    ) {
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        this.locale = locale;
    }

    public regionToId(region: Region): number {
        switch (region) {
            case Region.NorthAmerica:
                return 1;

            case Region.Korea:
                return 2;

            case Region.Europe:
                return 3;

            case Region.Taiwan:
                return 4;

            case Region.China:
                return 5;
        }
    }

    private idToRegion(id: number): Region {
        switch (id) {
            case 1:
                return Region.NorthAmerica;

            case 2:
                return Region.Korea;

            case 3:
                return Region.Europe;

            case 4:
                return Region.Taiwan;

            case 5:
                return Region.China;
        }
    }

    private getTranslatedText(translated: TranslatedText|string): string {
        if (typeof translated === 'string') return translated;

        return translated[this.locale];
    }

    private parseConnectedRealmUrl(url: string): number|boolean {
        const CONNECTED_REALM_REGEX = /connected-realm\/(?<id>[0-9]+)/;

        let matches;
        if ((matches = CONNECTED_REALM_REGEX.exec(url)) !== null) {
            return parseInt(matches.groups.id);
        }

        return false;
    }

    private async fetch(
        namespace: Namespace,
        url: string,
        method: string = 'GET',
        body: object = {},
        searchParams: URLSearchParams = new URLSearchParams(),
        headers: object = {}
    ) {
        if (this.authExpires == null || this.authExpires < (new Date()).getTime() / 1000) {
            await this.authenticate();
        }

        const hostname = (namespace.region === 'cn') ? `https://gateway.battlenet.com.cn/` : `https://${namespace.region}.api.blizzard.com/`;
        const fullUrl = `https://${namespace.region}.api.blizzard.com/${url.trimStart('/')}`;
        const urlParams = new URLSearchParams(searchParams);
        urlParams.set('namespace', `${namespace.lifetime}-${namespace.region}`);

        let requestInit: RequestInit = {
            method: method,
            headers: {
                ...headers,
                'Battlenet-Namespace': `${namespace.lifetime}-${namespace.region}`,
                'Authorization': `Bearer ${this.bearerToken}`
            },

        };

        if (Object.keys(body).length > 0) {
            requestInit.body = JSON.stringify(body);
            requestInit.headers['Content-Type'] = 'application/json';
        }

        return await fetch(fullUrl, requestInit);
    }

    private async authenticate() {
        const response = await fetch('https://oauth.battle.net/token', {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${btoa(`${process.env.BNET_CLIENT_ID}:${process.env.BNET_CLIENT_SECRET}`)}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({ grant_type: 'client_credentials' }),
        });

        if (!response.ok) {
            throw new Error(response.statusText);
        }

        let json = await response.json();
        let now = (new Date()).getTime() / 1000;

        this.authExpires = now + json.expires_in;
        this.bearerToken = json.access_token;
    }

    /**
     * Get a list of World of Warcraft connected realms
     *
     * @param region - The relevant region to search for
     * @returns a ConnectedRealmsResponse containing all connected realm IDs for the relevant region
     * */
    public async getConnectedRealms(
        region: Region
    ): Promise<ConnectedRealmsResponse> {
        const response = await this.fetch({
            lifetime: Lifetime.Dynamic,
            region
        }, `data/wow/connected-realm/index`);
        if (!response.ok) {
            throw new Error(response.statusText);
        }

        const json = await response.json();
        const realms = [];

        for (const realm of json.connected_realms) {
            let realmLink = realm.href;
            const CONNECTED_REALM_REGEX = /connected-realm\/(?<id>[0-9]+)/;

            let connectedRealmId;
            if ((connectedRealmId = this.parseConnectedRealmUrl(realmLink)) !== false) {
                realms.push(connectedRealmId);
            }
        }

        return {
            raw: json,
            connectedRealms: realms
        }
    }

    public async getConnectedRealmInformation(
        region: Region,
        realm: Realm|number
    ): Promise<ConnectedRealmInformationResponse> {
        let realmId = (typeof realm === 'number') ? realm : realm.connectedRealmId;

        const response = await this.fetch({
            lifetime: Lifetime.Dynamic,
            region
        }, `data/wow/connected-realm/${realmId}`);

        if (!response.ok) {
            throw new Error(response.statusText);
        }

        const json = await response.json();
        let realms: Realm[] = [];
        for (const respRealm of json.realms) {
            realms.push({
                id: respRealm.id,
                region: this.idToRegion(respRealm.region.id),
                connectedRealmId: this.parseConnectedRealmUrl(respRealm.connected_realm.href),
                name: this.getTranslatedText(respRealm.name),
                category: this.getTranslatedText(respRealm.category),
                locale: respRealm.locale,
                timezone: respRealm.timezone,
                type: respRealm.type,
                is_tournament: respRealm.is_tournament,
                slug: respRealm.slug
            });
        }
        return {
            raw: json,
            realms
        }
    }

    private parseAuctionListing(listing: object): AuctionItem {
        let pricePerUnit = listing.hasOwnProperty('unit_price') ? listing['unit_price'] : listing['buyout'];
        let item: AuctionItem = {
            auctionId: listing.id,
            itemId: listing.item.id,
            timeLeft: listing.time_left,
            quantity: listing.quantity,
            buyout: {
                copper: pricePerUnit % 100,
                silver: Math.floor(pricePerUnit / 100) % 100,
                gold: Math.floor(pricePerUnit / 10000) % 100,
                raw: pricePerUnit
            },
        };
        if ('bonus_lists' in listing.item) {
            item.bonuses = listing.item.bonus_lists;
        }

        if ('context' in listing.item) {
            item.context = listing.item.context;
        }

        if ('modifiers' in listing.item) {
            item.modifiers = listing.item.modifiers;
        }
        return item;
    }

    public async getConnectedRealmAuctions(
        region: Region,
        realm: Realm|number
    ): Promise<ConnectedRealmAuctionResponse> {
        let realmId = (typeof realm === 'number') ? realm : realm.connectedRealmId;

        const response = await this.fetch({
            lifetime: Lifetime.Dynamic,
            region
        }, `data/wow/connected-realm/${realmId}/auctions`);

        if (!response.ok) {
            throw new Error(response.statusText);
        }

        let json = await response.json();

        let auctions = [];

        for (const auctionItem of json.auctions) {
            auctions.push(this.parseAuctionListing(auctionItem));
        }

        return {
            raw: json,
            auctions: auctions
        }
    }

    public async getConnectedRealmCommodities(
        region: Region
    ): Promise<ConnectedRealmAuctionResponse> {
        const response = await this.fetch({
            lifetime: Lifetime.Dynamic,
            region
        }, `data/wow/auctions/commodities`);

        if (!response.ok) {
            throw new Error(response.statusText);
        }

        let json = await response.json();
        let auctions = [];

        for (const auctionItem of json.auctions) {
            auctions.push(this.parseAuctionListing(auctionItem));
        }

        return {
            raw: json,
            auctions: auctions
        }
    }
}

// response types
interface SingleLink {
    href: string
}
interface Reference {
    self: SingleLink
}

interface Translatable {
    type: string,
    name: TranslatedText
}
interface TranslatedText {
    en_US: string,
    es_MX: string,
    pt_BR: string,
    de_DE: string,
    en_GB: string,
    es_ES: string,
    fr_FR: string,
    it_IT: string,
    ru_RU: string,
    ko_KR: string,
    zh_TW: string,
    zh_CN: string
}

interface Realm {
    id: number,
    region: Region,
    connectedRealmId: number,
    name: string,
    category: string,
    locale: string,
    timezone: string,
    type: Translatable,
    is_tournament: boolean,
    slug: string
}

export interface BattleNetResponse {
    raw: object
}

export interface ConnectedRealmsResponse extends BattleNetResponse {
    connectedRealms: number[];
}

export interface ConnectedRealmInformationResponse extends BattleNetResponse {
    id: number,
    hasQueue: boolean,
    status: string,
    population: string,
    realms: Realm[]
}

export interface ConnectedRealmAuctionResponse extends BattleNetResponse {
    auctions: AuctionItem[];
}

export interface Money {
    gold: number,
    silver: number,
    copper: number
}

export interface AuctionItem {
    auctionId: number,
    itemId: number,
    context?: number,
    bonuses?: number[],
    modifiers?: number[],
    timeLeft: string,
    quantity: number,
    buyout: Money
}