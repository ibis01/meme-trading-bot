import { setDefaultAutoSelectFamily } from 'node:net';
import { setDefaultResultOrder } from 'node:dns';

setDefaultAutoSelectFamily(false);
setDefaultResultOrder('ipv4first');

export {};
