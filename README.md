# vfd-ascend

The Vida Ascend link: the tool server Vida calls to find a patient, register a
new one, find open times, book, cancel, reschedule, confirm, count missed visits
and leave a note in Dentrix Ascend.

Runs on CT 115 (npreg) as user npreg. Every Ascend call goes through one
signed-in, headed Chromium (Playwright) under user vida; every write is read
back before it reports success. Sign-in name in /etc/npreg/ascend.user, the
password beside it (vault entry "Dentrix Ascend Vida"); neither is in this repo.

Decisions: 2166 (build here), 1175 (signed-in browser), 1174 (rules and read-back),
1177 and 1169 (made-up test patients first), 2177 (Node 26, Playwright 1.65).
Code reaches GitHub through the pve mirror /var/lib/kramerica-promoter/github/vfd-ascend.git.
