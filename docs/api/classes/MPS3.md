[mps3](../API.md) / MPS3

# Class: MPS3

## Table of contents

### Constructors

- [constructor](MPS3.md#constructor)

### Properties

- [LOCAL\_ENDPOINT](MPS3.md#local_endpoint)

### Methods

- [delete](MPS3.md#delete)
- [get](MPS3.md#get)
- [put](MPS3.md#put)
- [putAll](MPS3.md#putall)
- [subscribe](MPS3.md#subscribe)

## Constructors

### constructor

• **new MPS3**(`config`): [`MPS3`](MPS3.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `config` | [`MPS3Config`](../interfaces/MPS3Config.md) |

#### Returns

[`MPS3`](MPS3.md)

#### Defined in

[mps3.ts:157](https://github.com/endpointservices/mps3/blob/f7c84ed/src/mps3.ts#L157)

## Properties

### LOCAL\_ENDPOINT

▪ `Static` **LOCAL\_ENDPOINT**: `string` = `"indexdb:"`

Virtual endpoint for local-first operation

#### Defined in

[mps3.ts:135](https://github.com/endpointservices/mps3/blob/f7c84ed/src/mps3.ts#L135)

## Methods

### delete

▸ **delete**(`ref`, `options?`): `Promise`\<`unknown`[]\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `ref` | `string` \| `Ref` |
| `options` | `Object` |
| `options.manifests?` | `Ref`[] |

#### Returns

`Promise`\<`unknown`[]\>

#### Defined in

[mps3.ts:366](https://github.com/endpointservices/mps3/blob/f7c84ed/src/mps3.ts#L366)

___

### get

▸ **get**(`ref`, `options?`): `Promise`\<`undefined` \| `JSONValue`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `ref` | `string` \| `Ref` |
| `options` | `Object` |
| `options.manifest?` | `Ref` |

#### Returns

`Promise`\<`undefined` \| `JSONValue`\>

#### Defined in

[mps3.ts:237](https://github.com/endpointservices/mps3/blob/f7c84ed/src/mps3.ts#L237)

___

### put

▸ **put**(`ref`, `value`, `options?`): `Promise`\<`unknown`[]\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `ref` | `string` \| `Ref` |
| `value` | `undefined` \| `JSONValue` |
| `options` | `Object` |
| `options.await?` | ``"local"`` \| ``"remote"`` |
| `options.manifests?` | `Ref`[] |

#### Returns

`Promise`\<`unknown`[]\>

#### Defined in

[mps3.ts:375](https://github.com/endpointservices/mps3/blob/f7c84ed/src/mps3.ts#L375)

___

### putAll

▸ **putAll**(`values`, `options?`): `Promise`\<`unknown`[]\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `values` | `Map`\<`string` \| `Ref`, `undefined` \| `JSONValue`\> |
| `options` | `Object` |
| `options.await?` | ``"local"`` \| ``"remote"`` |
| `options.isLoad?` | `boolean` |
| `options.manifests?` | `Ref`[] |

#### Returns

`Promise`\<`unknown`[]\>

#### Defined in

[mps3.ts:386](https://github.com/endpointservices/mps3/blob/f7c84ed/src/mps3.ts#L386)

___

### subscribe

▸ **subscribe**(`key`, `handler`, `options?`): () => `void`

Listen to a key for changes

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `key` | `string` \| `Ref` |  |
| `handler` | (`value`: `undefined` \| `JSONValue`, `error?`: `Error`) => `void` | callback to be notified of changes |
| `options?` | `Object` | - |
| `options.manifest?` | `Ref` | - |

#### Returns

`fn`

unsubscribe function

▸ (): `void`

##### Returns

`void`

#### Defined in

[mps3.ts:568](https://github.com/endpointservices/mps3/blob/f7c84ed/src/mps3.ts#L568)
