S3 is an XML-based API. When you do a list operation i.e. [GET /\<bucket>?list-type=2](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectsV2.html) you get a response of the following
```
HTTP/1.1 200
x-amz-request-charged: RequestCharged
<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
   <IsTruncated>boolean</IsTruncated>
   <Contents>
      <ChecksumAlgorithm>string</ChecksumAlgorithm>
      ...
      <ETag>string</ETag>
      <Key>string</Key>
      <LastModified>timestamp</LastModified>
      <Owner>
         <DisplayName>string</DisplayName>
         <ID>string</ID>
      </Owner>
      <RestoreStatus>
         <IsRestoreInProgress>boolean</IsRestoreInProgress>
         <RestoreExpiryDate>timestamp</RestoreExpiryDate>
      </RestoreStatus>
      <Size>long</Size>
      <StorageClass>string</StorageClass>
   </Contents>
   ...
   <Name>string</Name>
   <Prefix>string</Prefix>
   <Delimiter>string</Delimiter>
   <MaxKeys>integer</MaxKeys>
   <CommonPrefixes>
      <Prefix>string</Prefix>
   </CommonPrefixes>
   ...
   <EncodingType>string</EncodingType>
   <KeyCount>integer</KeyCount>
   <ContinuationToken>string</ContinuationToken>
   <NextContinuationToken>string</NextContinuationToken>
   <StartAfter>string</StartAfter>
</ListBucketResult>
```
The most salient thing for listing is the `<Contents>` blocks which enumerate the contents of the bucket. Of particular interest is the `<Key>` element, which specifies keys you can look up with a `GetObject` API request.

### Escaping

One of the most notorious difficulties with [XML is escaping](https://stackoverflow.com/questions/1091945/what-characters-do-i-need-to-escape-in-xml-documents). Control characters like `<` are special and should be replaced with `&lt`. Slashes  `/` are super special and directory deliminators.  Furthermore, XML supports a special block syntax `<![CDATA[...]]>` for character data that should *not* be escaped.

So this begs the question, what does the S3 API return when the keys contain special data? I tried uploading files with the following keys, through the S3 console interface
- `&lt`
- `<![CDATA[...]]>`
- `foo<Contents>`

Interestingly the CDATA block hit something strange which manifested as noise in UI of the type

![](attachments/Pasted%20image%2020231014104750.png)


However, the underlying response in the XML response is escaped with URL encoding (`%26` not `&amp`, `%3C` not `&lt`). So these represents tricky cases that should be considered when testing vendor conformance or alternative parsing mechanisms.
```
<Key>%26lt</Key>
<Key>%3C%21%5BCDATA%5B...%5D%5D%3E</Key>
<Key>foo%3CContents%3E</Key>
```

### Amazon key guidelines
Amazon publishes a [guideline](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-keys.html) on S3 keynames. Special handling is required for
- `&$@=;/:+,?` 
- multiple spaces
- ASCII ranges `0–31`
Amazon says to avoid 
- `\{^}%\]">[~#|` and backticks
- ASCII range `128–255`

Trying to upload files with names
- `&$@=;  :+,?`
- `\{^}%\]">[~#|`

yields

```
<Key>%26%24%40%3D%3B++%3A%2B%2C%3F</Key>
<Key>%5C%7B%5E%7D%25%5C%5D%22%3E%5B%7E%23%7C</Key>
```
Notice spaces are converted to `+` while `+` is URL encoded to `%2B`, this is `x-www-form-urlencoded` *not* the similar URI encoding(!).

### Unit Test

Tested in conformance testing [here](https://github.com/endpointservices/mps3/blob/640648c2bb6f4f0b5cf45cb659b97a21ede862dc/src/__tests__/conformance.test.ts#L284). Note `\x00` should work but doesn't (might be a runtime issue).

