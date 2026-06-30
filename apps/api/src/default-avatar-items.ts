/**
 * Default avatar items for `GET /api/avatar/v4/items`.
 * Stored as `[AvatarItemDesc, FriendlyName, Rarity?]`
 * tuples — every entry shares `AvatarItemType: 0`, `PlatformMask: -1`, `Tooltip: ""`,
 * and `Rarity` defaults to `0`.
 */
export interface AvatarItem {
	AvatarItemType: number
	AvatarItemDesc: string
	PlatformMask: number
	FriendlyName: string
	Tooltip: string
	Rarity: number
}

type Entry = readonly [desc: string, friendlyName: string, rarity?: number]

const ENTRIES: readonly Entry[] = [
	['5d13a7a2-8213-40e6-90a6-efdd76a3fdcb,,,', 'Flowing Hair'],
	['1d27b674-f9e2-4ffc-9d8c-a58a1be06457,,,', 'Afro Hair'],
	['d84c0ff9-8fbe-4ed8-abf3-7996e81888ab,,,', 'Large Afro Hair'],
	['e5b83dfc-b2e1-4dcb-a4ab-9d3a4c8a34ae,,,', 'Long Wavy Hair'],
	['7dd6f7b0-7ba0-429f-a04f-e32d3a79ee61,,,', 'Short Wavy Hair'],
	['eb9611c6-bb50-41a2-93e9-7f959815a846,,,', 'Dreads Long Hair'],
	['1fd69ef8-0b74-4962-af5a-67f0bf0358f2,,,', 'Ponytail Hair'],
	['a12f724f-4a73-4ab8-aad4-6bfc662b4dd6,,,', 'Undercut Long Hair'],
	['0753d7a4-8247-4fca-a6fc-359c26086140,,,', 'Fonzie Hair'],
	['77d3c585-4928-4471-a425-89036efe7299,,,', 'Spiky Hair'],
	['92302d9d-c527-418c-ac5d-1fa869727505,,,', 'Part Hair'],
	['f9dd08f8-16d3-4c39-af4f-89f7bb6e80d3,,,', 'Undercut Short Hair'],
	['b148cb1e-df81-442f-aea6-ab1727aad00e,,,', 'Chunky Afro Hair'],
	['e36bcd98-7e85-43fa-89f8-57e4ec33823a,,,', 'Bob with Bangs Hair'],
	['880a3cc0-7407-4b61-b759-f9dd890fe9e5,,,', 'Bob Hair'],
	['21599b51-c50f-43d8-ac5f-62c30cd02ca5,,,', 'Lori Hair'],
	['193a3bf9-abc0-4d78-8d63-92046908b1c5,,,', 'Emo Hair'],
	['79b90274-6eec-4664-acfb-4a123334661e,,,', 'Pig Tails Hair'],
	['da4e7b34-2095-4a9e-801e-4f409039e0dd,,,', 'Buzz Cut Hair'],
	['9d9fadb6-97eb-480e-a224-4e0179082071,,,', 'Meatball Buns Hair'],
	['d8280c0c-d803-4513-be10-a0ba96d8821e,,,', 'Flowhawk Hair'],
	['e286863c-2967-4d00-b837-b49487b9484a,,,', 'Fauxhawk Hair'],
	['2cb4f372-3372-4583-8b57-c4e3988e3c28,,,', 'Punky Hair'],
	['06306723-ca20-4aa6-b7b3-917113f41ac3,,,', 'Cat-Eye Glasses (Red)'],
	['c70005d5-6276-4a98-acb3-6a77bc19379a,,,', 'Glasses (Teal)'],
	['8d10cc78-6b00-45f3-affb-205e9cc5b03f,,,', 'Beard (Close)'],
	['cc96f8a5-bc5b-4f89-83b7-ecd53905ada7,,,', 'Beard (Thick)'],
	['c6c08eb5-381a-4193-9722-80da95d62abe,,,', 'Business Tie (Black)'],
	['4d507dfa-4a99-4ac0-8537-229e9dc0eb4a,,,', 'Rec Room Tank Top (Orange)'],
	['d0a9262f-5504-46a7-bb10-7507503db58e,,,', 'Rec Room Shirt (Crew Neck, White)'],
	[
		'd0a9262f-5504-46a7-bb10-7507503db58e,95e4cc30-cb68-473d-a395-feadf5b51512,0440f08f-ef1d-49d8-942b-523056e8bb45,',
		'Rec Room T-Shirt (Crew Neck, Orange)',
	],
	['2e59d8d0-91a0-4449-bfdc-a5d663fd9343,,,', 'Collared Shirt (Plaid, Blue)'],
	['7b857a8c-92ad-4028-a2c2-b3c20cdab5f2,,,', 'T-Shirt'],
	['8aa79563-ace1-4ba7-ad0c-f3210a78142f,,,', 'Rec Room Shirt (V-Neck, White)'],
	[
		'8aa79563-ace1-4ba7-ad0c-f3210a78142f,95e4cc30-cb68-473d-a395-feadf5b51512,05f0ee6e-c824-470e-9178-5ed576c6fe0c,',
		'Rec Room T-Shirt (V-Neck, Orange)',
	],
	['21caa68e-c3fa-474c-af5e-af1e742b7a60,,,', 'Tennis Skirt (Blue)'],
	[
		'21caa68e-c3fa-474c-af5e-af1e742b7a60,c5deba2a-6e35-4b13-8e94-8ba5457f39df,b75ef67d-00c3-4ac1-9b72-212032460294,',
		'Tennis Skirt (Yellow)',
	],
	[
		'21caa68e-c3fa-474c-af5e-af1e742b7a60,758752bd-db2f-43d2-b580-55b3e1efffd5,b75ef67d-00c3-4ac1-9b72-212032460294,',
		'Tennis Skirt (Red)',
	],
	['2296ed0d-df56-4d46-b33a-aae9230a47fc,,,', 'Zipper Dress (Yellow)'],
	['ecc1dbe6-ca06-4564-b2a6-30956194d1e9,,,', 'Wristbands (White)'],
	['71921831-ba6f-408b-a00e-2fd97663636f,,,', 'Wrist Tape (White)'],
	[
		'2e59d8d0-91a0-4449-bfdc-a5d663fd9343,55901f12-d5b5-4fa8-b4c8-e479689ee39d,f600037d-c9c0-43fa-b45b-02f456f9dd5f,',
		'Collared Shirt (Denim)',
	],
	[
		'2e59d8d0-91a0-4449-bfdc-a5d663fd9343,bf82f2f6-9af8-431e-a296-0890dea48ba7,d015cae7-a905-49e4-8823-6dec069689a6,',
		'Collared Shirt (Argyle)',
	],
	[
		'2e59d8d0-91a0-4449-bfdc-a5d663fd9343,EfdMcnfHt0mr0PQ_maaYOg,DRJcNhkqvkKFEaZpOguR6w,',
		'Collared Shirt (Flowers, Green)',
	],
	[
		'7b857a8c-92ad-4028-a2c2-b3c20cdab5f2,6d703981-2734-4c45-8983-cdd5f328902f,a0271cd0-e172-4d3f-aa2f-9806f21a82d2,',
		'Tank Top (Camo)',
	],
	[
		'7b857a8c-92ad-4028-a2c2-b3c20cdab5f2,5c4a2b35-0e1c-44de-8c3a-96d4a6458b1b,9c03f381-7357-4d0f-8cda-8737d4c43d25,',
		'Tank Top (Rainbow)',
	],
	[
		'7b857a8c-92ad-4028-a2c2-b3c20cdab5f2,51ef8d39-2b94-4f9e-9620-07b6b0a913a5,d2a692e6-e1a9-4cfe-8154-10b52be7f8c8,',
		'Jersey (Orange)',
		10,
	],
	[
		'7b857a8c-92ad-4028-a2c2-b3c20cdab5f2,ad61c418-6d77-4a99-8ac5-9f10f5a3d42f,b292eb4b-07e3-4a48-99b5-3c6587a1e02e,',
		'Tank Top (Dots)',
	],
	[
		'7b857a8c-92ad-4028-a2c2-b3c20cdab5f2,48abd952-214f-48b2-a8f1-1146f6f69aa2,b78008e8-abbd-4ece-be34-9a911f721fcc,',
		'Tank Top (Zebra)',
	],
	[
		'14ef6b00-debf-4a85-9755-b4d37df496d3,8377ab96-c908-457f-9fee-b784c9a759f3,0b2395e1-ebcc-47e9-aaf1-faf9e9cec4cd,',
		'Baseball Cap (Red)',
	],
	[
		'14ef6b00-debf-4a85-9755-b4d37df496d3,dee70c38-7a99-4c2b-9181-665f1bf75aca,0b2395e1-ebcc-47e9-aaf1-faf9e9cec4cd,',
		'Baseball Cap (Blue)',
	],
	[
		'40528de7-38a3-4a7c-8f93-6d3bfa5573f2,7d8e55fe-3c34-4b4b-9753-0021f6cc6454,0b2395e1-ebcc-47e9-aaf1-faf9e9cec4cd,',
		'Headband (Cream)',
	],
	[
		'40528de7-38a3-4a7c-8f93-6d3bfa5573f2,1b1d08f2-12ca-43dd-a44f-ea2820b919b4,0b2395e1-ebcc-47e9-aaf1-faf9e9cec4cd,',
		'Headband (Black)',
	],
	[
		'40528de7-38a3-4a7c-8f93-6d3bfa5573f2,51ef8d39-2b94-4f9e-9620-07b6b0a913a5,018a5c07-e956-457d-a540-a5e2cd68da09,',
		'Headband (Orange, White)',
	],
	[
		'40528de7-38a3-4a7c-8f93-6d3bfa5573f2,cbe29e9f-f2ac-47fb-97e1-8bad16abb89d,018a5c07-e956-457d-a540-a5e2cd68da09,',
		'Headband (Pink, White)',
	],
	[
		'40528de7-38a3-4a7c-8f93-6d3bfa5573f2,dee70c38-7a99-4c2b-9181-665f1bf75aca,018a5c07-e956-457d-a540-a5e2cd68da09,',
		'Headband (Blue, White)',
	],
	[
		'40528de7-38a3-4a7c-8f93-6d3bfa5573f2,6dd95046-acf8-42fe-ab78-80a334096a9d,56a92c8d-af53-413e-929e-4a9a3cfad780,',
		'Headband (Red, White, Blue)',
	],
	[
		'ecc1dbe6-ca06-4564-b2a6-30956194d1e9,dee70c38-7a99-4c2b-9181-665f1bf75aca,0b2395e1-ebcc-47e9-aaf1-faf9e9cec4cd,',
		'Wristbands (Blue)',
	],
	[
		'ecc1dbe6-ca06-4564-b2a6-30956194d1e9,1b1d08f2-12ca-43dd-a44f-ea2820b919b4,0b2395e1-ebcc-47e9-aaf1-faf9e9cec4cd,',
		'Wristbands (Black)',
	],
	[
		'ecc1dbe6-ca06-4564-b2a6-30956194d1e9,51ef8d39-2b94-4f9e-9620-07b6b0a913a5,0b2395e1-ebcc-47e9-aaf1-faf9e9cec4cd,',
		'Wristbands (Orange)',
	],
	[
		'ecc1dbe6-ca06-4564-b2a6-30956194d1e9,cbe29e9f-f2ac-47fb-97e1-8bad16abb89d,0b2395e1-ebcc-47e9-aaf1-faf9e9cec4cd,',
		'Wristbands (Pink)',
	],
	[
		'ecc1dbe6-ca06-4564-b2a6-30956194d1e9,8377ab96-c908-457f-9fee-b784c9a759f3,0b2395e1-ebcc-47e9-aaf1-faf9e9cec4cd,',
		'Wristbands (Red)',
	],
	['fcfcaf63-deb4-45f7-b711-c051c9ea45cb,,,', 'Top Bun Hair'],
	['de0ac50d-2adb-4114-bd2e-68953b13d706,,,', 'Blazer (Blue, White)'],
	[
		'de0ac50d-2adb-4114-bd2e-68953b13d706,6f2e74bf-1e95-463d-97db-d5d1a53b2c28,be2b9293-1d3c-4b1c-b4c5-fad3ab16cf54,',
		'Blazer (Black, White)',
	],
	[
		'de0ac50d-2adb-4114-bd2e-68953b13d706,9374bf66-2ee5-493b-8439-efce4b201904,be2b9293-1d3c-4b1c-b4c5-fad3ab16cf54,',
		'Blazer (Grey, Black)',
	],
	[
		'de0ac50d-2adb-4114-bd2e-68953b13d706,272fe8eb-5061-4729-a7a8-414ff667a82f,be2b9293-1d3c-4b1c-b4c5-fad3ab16cf54,',
		'Blazer (Grey, White)',
	],
	[
		'de0ac50d-2adb-4114-bd2e-68953b13d706,0ffad843-d6c9-425a-8686-7217009c867e,be2b9293-1d3c-4b1c-b4c5-fad3ab16cf54,',
		'Blazer (Green, Black)',
	],
	[
		'9c8fc7f0-8f99-4aad-a34f-8d979f6ae352,e0397982-c2c2-4733-9a40-46e18675b5af,dafa658e-753b-46cb-bd85-85c1de5e6ea7,',
		'Button Top (Orange)',
	],
	['9c8fc7f0-8f99-4aad-a34f-8d979f6ae352,,,', 'Button Top (Pink)'],
	[
		'9c8fc7f0-8f99-4aad-a34f-8d979f6ae352,49f5864f-9d40-497c-88c8-e87f64d41d74,dafa658e-753b-46cb-bd85-85c1de5e6ea7,',
		'Button Top (Tan)',
	],
	[
		'9c8fc7f0-8f99-4aad-a34f-8d979f6ae352,c5deba2a-6e35-4b13-8e94-8ba5457f39df,dafa658e-753b-46cb-bd85-85c1de5e6ea7,',
		'Button Top (Yellow)',
	],
	[
		'6d815b35-6f68-4ed4-817d-70f141e1a571,f750de46-3758-4f7d-9709-0a84b1027009,2c8924aa-68f8-4912-9759-18992f72f08a,',
		'Collared Dress (Blue)',
	],
	[
		'6d815b35-6f68-4ed4-817d-70f141e1a571,d66aa400-aa5a-4539-a25d-5f8ce94dc281,2c8924aa-68f8-4912-9759-18992f72f08a,',
		'Collared Dress (Green)',
	],
	[
		'6d815b35-6f68-4ed4-817d-70f141e1a571,6564acf1-4d70-4f92-92ac-08e2b76dbb6b,2c8924aa-68f8-4912-9759-18992f72f08a,',
		'Collared Dress (Purple)',
	],
	['6d815b35-6f68-4ed4-817d-70f141e1a571,,,', 'Collared Dress (Red)'],
	['241506f6-bf88-4b46-b5fe-513a225421f4,,,', 'Half Up Hair'],
	[
		'6b9e022c-0b68-48fd-8eca-da8573c18900,d6edbc00-3c1d-4f49-8412-3ef8c7c5f4c2,cf119781-5bd9-4b85-9a0b-12e82e988c23,',
		'Long Scarf (Blue)',
	],
	[
		'2296ed0d-df56-4d46-b33a-aae9230a47fc,6d703981-2734-4c45-8983-cdd5f328902f,cfabdefe-0890-436e-b2a3-b5c712e22955,',
		'Zipper Dress (Green)',
	],
	[
		'2296ed0d-df56-4d46-b33a-aae9230a47fc,830be2fa-60a5-48cc-931f-34b670eae4bd,cfabdefe-0890-436e-b2a3-b5c712e22955,',
		'Zipper Dress (Purple)',
	],
	[
		'2296ed0d-df56-4d46-b33a-aae9230a47fc,bbfa08e3-8e6b-4e0f-b264-1b398d7cd44a,cfabdefe-0890-436e-b2a3-b5c712e22955,',
		'Zipper Dress (White)',
	],
	[
		'ecc1dbe6-ca06-4564-b2a6-30956194d1e9,484b6c13-af22-4ad5-8c43-34c0de095d49,0b2395e1-ebcc-47e9-aaf1-faf9e9cec4cd,',
		'Wristbands (Light Blue)',
	],
	[
		'ecc1dbe6-ca06-4564-b2a6-30956194d1e9,f8b0cfe8-e129-4578-8bb5-f60af5d38599,0b2395e1-ebcc-47e9-aaf1-faf9e9cec4cd,',
		'Wristbands (Green)',
	],
	[
		'ecc1dbe6-ca06-4564-b2a6-30956194d1e9,67bcca75-4ab1-4964-8688-9908c464d355,0b2395e1-ebcc-47e9-aaf1-faf9e9cec4cd,',
		'Wristbands (Gold)',
	],
	[
		'7b857a8c-92ad-4028-a2c2-b3c20cdab5f2,1b1d08f2-12ca-43dd-a44f-ea2820b919b4,0b2395e1-ebcc-47e9-aaf1-faf9e9cec4cd,',
		'Tank Top (Black)',
	],
	[
		'7b857a8c-92ad-4028-a2c2-b3c20cdab5f2,dee70c38-7a99-4c2b-9181-665f1bf75aca,0b2395e1-ebcc-47e9-aaf1-faf9e9cec4cd,',
		'Tank Top (Blue)',
	],
	[
		'7b857a8c-92ad-4028-a2c2-b3c20cdab5f2,51ef8d39-2b94-4f9e-9620-07b6b0a913a5,0b2395e1-ebcc-47e9-aaf1-faf9e9cec4cd,',
		'Tank Top (Orange)',
	],
	[
		'7b857a8c-92ad-4028-a2c2-b3c20cdab5f2,8377ab96-c908-457f-9fee-b784c9a759f3,0b2395e1-ebcc-47e9-aaf1-faf9e9cec4cd,',
		'Tank Top (Red)',
	],
	[
		'6b9e022c-0b68-48fd-8eca-da8573c18900,5c4a2b35-0e1c-44de-8c3a-96d4a6458b1b,cf119781-5bd9-4b85-9a0b-12e82e988c23,',
		'Long Scarf (Purple)',
	],
	[
		'6b9e022c-0b68-48fd-8eca-da8573c18900,6dd95046-acf8-42fe-ab78-80a334096a9d,cf119781-5bd9-4b85-9a0b-12e82e988c23,',
		'Long Scarf (White)',
	],
	[
		'40528de7-38a3-4a7c-8f93-6d3bfa5573f2,dee70c38-7a99-4c2b-9181-665f1bf75aca,0b2395e1-ebcc-47e9-aaf1-faf9e9cec4cd,',
		'Headband (Blue)',
	],
	[
		'40528de7-38a3-4a7c-8f93-6d3bfa5573f2,f8b0cfe8-e129-4578-8bb5-f60af5d38599,0b2395e1-ebcc-47e9-aaf1-faf9e9cec4cd,',
		'Headband (Green)',
	],
	[
		'40528de7-38a3-4a7c-8f93-6d3bfa5573f2,8377ab96-c908-457f-9fee-b784c9a759f3,0b2395e1-ebcc-47e9-aaf1-faf9e9cec4cd,',
		'Headband (Red)',
	],
	['40528de7-38a3-4a7c-8f93-6d3bfa5573f2,,,', 'Headband (White)'],
	[
		'40528de7-38a3-4a7c-8f93-6d3bfa5573f2,67bcca75-4ab1-4964-8688-9908c464d355,0b2395e1-ebcc-47e9-aaf1-faf9e9cec4cd,',
		'Headband (Yellow)',
	],
	['24a240f4-1574-420b-b898-a7e91f170759,,,', 'Back Bun Hair'],
	['c45ed7b8-99bd-4a4b-a9ff-e16edf5d7a18,,,', 'High Pony Hair'],
	[
		'14ef6b00-debf-4a85-9755-b4d37df496d3,484b6c13-af22-4ad5-8c43-34c0de095d49,0b2395e1-ebcc-47e9-aaf1-faf9e9cec4cd,',
		'Baseball Cap (Light Blue)',
	],
	[
		'14ef6b00-debf-4a85-9755-b4d37df496d3,1b1d08f2-12ca-43dd-a44f-ea2820b919b4,0b2395e1-ebcc-47e9-aaf1-faf9e9cec4cd,',
		'Baseball Cap (Black)',
	],
	[
		'14ef6b00-debf-4a85-9755-b4d37df496d3,51ef8d39-2b94-4f9e-9620-07b6b0a913a5,0b2395e1-ebcc-47e9-aaf1-faf9e9cec4cd,',
		'Baseball Cap (Orange)',
	],
	['14ef6b00-debf-4a85-9755-b4d37df496d3,,,', 'Baseball Cap (White)'],
	[
		'14ef6b00-debf-4a85-9755-b4d37df496d3,67bcca75-4ab1-4964-8688-9908c464d355,0b2395e1-ebcc-47e9-aaf1-faf9e9cec4cd,',
		'Baseball Cap (Yellow)',
	],
	['896c2491-2f96-4986-9cbd-b3b31ef5d8c5,,,', 'Equestrian Coat (Black)'],
	[
		'896c2491-2f96-4986-9cbd-b3b31ef5d8c5,55901f12-d5b5-4fa8-b4c8-e479689ee39d,d344b8cc-85a8-4ace-9f92-38c84f396e99,',
		'Equestrian Coat (Blue)',
	],
	[
		'896c2491-2f96-4986-9cbd-b3b31ef5d8c5,4828b50c-95b6-466a-bb25-514891d78202,d344b8cc-85a8-4ace-9f92-38c84f396e99,',
		'Equestrian Coat (Grey)',
	],
	[
		'896c2491-2f96-4986-9cbd-b3b31ef5d8c5,d6823e01-69f0-4f85-b94a-74894356a2cf,d344b8cc-85a8-4ace-9f92-38c84f396e99,',
		'Equestrian Coat (Maroon)',
	],
	['09177621-9ecd-4f6a-b6a5-64490139141d,,,', 'Flat Top Hair'],
	['95ab7a7c-c35d-4da5-9955-0921064470b6,,,', 'Gekko Hair'],
	[
		'40528de7-38a3-4a7c-8f93-6d3bfa5573f2,0ecb8a2a-cffc-47db-aeda-fb0684aef1e5,0b2395e1-ebcc-47e9-aaf1-faf9e9cec4cd,',
		'Headband (Grey)',
	],
	[
		'40528de7-38a3-4a7c-8f93-6d3bfa5573f2,484b6c13-af22-4ad5-8c43-34c0de095d49,0b2395e1-ebcc-47e9-aaf1-faf9e9cec4cd,',
		'Headband (Light Blue)',
	],
	[
		'40528de7-38a3-4a7c-8f93-6d3bfa5573f2,51ef8d39-2b94-4f9e-9620-07b6b0a913a5,0b2395e1-ebcc-47e9-aaf1-faf9e9cec4cd,',
		'Headband (Orange)',
	],
	[
		'40528de7-38a3-4a7c-8f93-6d3bfa5573f2,cbe29e9f-f2ac-47fb-97e1-8bad16abb89d,0b2395e1-ebcc-47e9-aaf1-faf9e9cec4cd,',
		'Headband (Pink)',
	],
	[
		'40528de7-38a3-4a7c-8f93-6d3bfa5573f2,8377ab96-c908-457f-9fee-b784c9a759f3,018a5c07-e956-457d-a540-a5e2cd68da09,',
		'Headband (Red, White)',
	],
	['62ce4109-8dee-4895-bf1b-bfa143db4c7e,,,', 'Slim Blazer (Teal)'],
	[
		'62ce4109-8dee-4895-bf1b-bfa143db4c7e,cd5d7285-202d-42d0-b93f-04245875793e,0f36bb97-c61b-4281-929f-ff1d0d11be86,',
		'Slim Blazer (Green)',
	],
	[
		'62ce4109-8dee-4895-bf1b-bfa143db4c7e,ad61c418-6d77-4a99-8ac5-9f10f5a3d42f,0f36bb97-c61b-4281-929f-ff1d0d11be86,',
		'Slim Blazer (Blue)',
	],
	['8b9f1413-e786-4a30-946c-9292f207875a,,,', 'Pulp Hair'],
	['5cd08cfb-c729-4c30-96d9-6a99bb934d91,,,', 'Rec Room Sash'],
	['1a71064b-794f-40fa-9109-8ad36602b6e1,,,', 'Shagg Hair'],
	[
		'84cd594c-1cd8-4b4d-8409-85c8fd5fb02a,761a3193-60f0-4190-80c7-285b8192e794,91a451c1-b285-4c48-b14d-59ded8cc006f,',
		'Stoll Dress (Blue)',
	],
	[
		'84cd594c-1cd8-4b4d-8409-85c8fd5fb02a,a819f49b-6c7a-49d3-9e6a-d9d79ef5019f,91a451c1-b285-4c48-b14d-59ded8cc006f,',
		'Stoll Dress (Green)',
	],
	[
		'84cd594c-1cd8-4b4d-8409-85c8fd5fb02a,64850553-cdfe-455a-ac00-dafbe63d613e,91a451c1-b285-4c48-b14d-59ded8cc006f,',
		'Stoll Dress (Orange)',
	],
	['84cd594c-1cd8-4b4d-8409-85c8fd5fb02a,,,', 'Stoll Dress (Pink)'],
	[
		'71921831-ba6f-408b-a00e-2fd97663636f,1b1d08f2-12ca-43dd-a44f-ea2820b919b4,0b2395e1-ebcc-47e9-aaf1-faf9e9cec4cd,',
		'Wrist Tape (Black)',
	],
	[
		'71921831-ba6f-408b-a00e-2fd97663636f,7d8e55fe-3c34-4b4b-9753-0021f6cc6454,0b2395e1-ebcc-47e9-aaf1-faf9e9cec4cd,',
		'Wrist Tape (Cream)',
	],
	[
		'ecc1dbe6-ca06-4564-b2a6-30956194d1e9,0ecb8a2a-cffc-47db-aeda-fb0684aef1e5,0b2395e1-ebcc-47e9-aaf1-faf9e9cec4cd,',
		'Wristbands (Grey)',
	],
	[
		'ecc1dbe6-ca06-4564-b2a6-30956194d1e9,7d8e55fe-3c34-4b4b-9753-0021f6cc6454,0b2395e1-ebcc-47e9-aaf1-faf9e9cec4cd,',
		'Wristbands (Cream)',
	],
	['6b9e022c-0b68-48fd-8eca-da8573c18900,,,', 'Long Scarf (Red)'],
	[
		'2e59d8d0-91a0-4449-bfdc-a5d663fd9343,0iSsaY-HgkmLaRHCn5vEdw,PioQ0o3yP0a6szPZ4EKs2A,',
		'Collared Shirt (Blue)',
	],
	[
		'2e59d8d0-91a0-4449-bfdc-a5d663fd9343,jGj28vhq8EGwP2RuM074aQ,PioQ0o3yP0a6szPZ4EKs2A,',
		'Collared Shirt (Yellow)',
	],
	[
		'2e59d8d0-91a0-4449-bfdc-a5d663fd9343,kmj5zOjcwku_WWKroCeiVQ,PioQ0o3yP0a6szPZ4EKs2A,',
		'Collared Shirt (Pink)',
	],
	[
		'2e59d8d0-91a0-4449-bfdc-a5d663fd9343,FAviMCQ_EE2Mpt6QPo5OEw,PioQ0o3yP0a6szPZ4EKs2A,',
		'Collared Shirt (Red)',
	],
	[
		'2e59d8d0-91a0-4449-bfdc-a5d663fd9343,MFrcSQ1DYUm8imvy4ypgvw,PioQ0o3yP0a6szPZ4EKs2A,',
		'Collared Shirt (White)',
	],
	[
		'de0ac50d-2adb-4114-bd2e-68953b13d706,05ac07e1-67f0-486c-abf5-a62866475abb,be2b9293-1d3c-4b1c-b4c5-fad3ab16cf54,',
		'Blazer (Black, Cream)',
	],
	['0088603e-ec3b-4478-8694-e6fb1989b3f2,,,', 'Angled Bob Hair'],
	['ffea7a65-613f-4835-921e-6dd15f357b7e,,,', 'Long Bangs Hair'],
	['45f5e714-8a5f-4385-a97f-675066167011,,,', 'Seventies Stache'],
	['9bf5d259-7774-4cbe-a90f-7f188cc0dce7,,,', 'Thick Goatee'],
	['a6cbfe76-534a-4655-a8a8-3fed13d001c7,,,', 'Bald Top Hair'],
	['CTcrvbo3OEepIV4oW8bx4w,,,', 'Receding Hair'],
	['-twtjyBdQ02EAdOfBGTiEw,,,', 'Van Dyke Beard'],
	['45eaab67-19c2-4601-8f80-3565a4dceba4,,,', 'Pompadour Hair'],
	['c855dcc3-96cb-470d-b159-d37a025a47d1,,,', 'Dutch Braid Hair'],
	['d7730a9e-78a1-4356-bc09-6b066615850b,,,', 'Afro Updo Hair'],
	['8c35c804-e8d5-49d2-8d5a-ea19fb70bfa6,,,', 'Pencil Bun Hair'],
	['5beeb4c4-f276-4eae-87aa-9302e45b05b7,,,', 'Cornrows Hair'],
	[
		'b6rLwzD4NkKV7xKn9ZYVkA,sxUE0iOSZEmezm54T7xI3Q,tlpa7195x0CkmSjpR1RArQ,',
		'Rec Room Hoodie - Pride (Rainbow Pride)',
	],
	['fe15ca53-c5b8-4acf-9309-ff3f4e610fc9,,,', 'Winged Hat - Pride (Rainbow Pride)'],
	[
		'b6rLwzD4NkKV7xKn9ZYVkA,D_Xmo0rOzkS-kgq1CYXt3g,tnCJp2eDI0SwjVfJMhk3LQ,',
		'Rec Room Hoodie - Pride (Trans Pride)',
	],
	[
		'fe15ca53-c5b8-4acf-9309-ff3f4e610fc9,knXPidb-Rkayfc3kSHfZeQ,1yMyo6oTjU-VAygoeWaohQ,',
		'Winged Hat - Pride (Trans Pride)',
	],
	['88b6ddeb-a455-460d-91d9-a4569ef6903c,,,', 'Square Earrings '],
	['0abb6b08-20ce-444f-879e-0d1344df096c,,,', 'Round Earrings'],
	['9b5bde11-7408-4798-9fcb-c7ec175444df,,,', 'Hoop Earrings'],
]

export const DEFAULT_AVATAR_ITEMS: readonly AvatarItem[] = ENTRIES.map(
	([AvatarItemDesc, FriendlyName, rarity]) => ({
		AvatarItemType: 0,
		AvatarItemDesc,
		PlatformMask: -1,
		FriendlyName,
		Tooltip: '',
		Rarity: rarity ?? 0,
	})
)
