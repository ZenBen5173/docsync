import pytest

from app.compare.normalize import (is_order_only, normalise_party, normalise_port, parse_container_count,
                                   parse_number, parse_weight_kg, party_core)


# ---------------------------------------------------------------- numbers / weights
@pytest.mark.parametrize("text,expected", [
    ("131,058", 131058), ("131,058 KG", 131058), ("131058", 131058), ("131 058", 131058),
    ("131.058,50", 131058.5), ("1,234,567.8", 1234567.8), ("21.5", 21.5), ("131.058", 131058),
    ("20,842 KG", 20842), ("243,588", 243588), ("0", 0),
])
def test_parse_number(text, expected):
    assert parse_number(text) == pytest.approx(expected)


def test_parse_number_none():
    assert parse_number("N/A") is None
    assert parse_number("") is None


@pytest.mark.parametrize("value,label,kg", [
    ("21,577 KG", "", 21577), ("21577", "Gross Weight (KG)", 21577), ("21,577 KGS", "Gross Wt (kgs)", 21577),
    ("21.577 MT", "", 21577), ("21.577", "Gross Weight (MT)", 21577), ("138 MT", "", 138000),
    ("1000 lbs", "", 453.592), ("341715", "GROSS WEIGHT", 341715), ("20,842kg", "", 20842),
])
def test_parse_weight(value, label, kg):
    assert parse_weight_kg(value, label) == pytest.approx(kg, rel=1e-4)


def test_weight_blank_is_none():
    assert parse_weight_kg("____MT") is None
    assert parse_weight_kg("TBA") is None


# ---------------------------------------------------------------- containers
@pytest.mark.parametrize("value,count", [
    ("3 x 40HC", 3), ("6 x 40'HC", 6), ("1 x 20'GP", 1), ("12X20'FCL", 12), ("3×40HC", 3), ("3 * 40 HC", 3),
    ("2x20GP + 1x40HC", 3), ("THREE (3)", 3), ("THREE (3) CONTAINERS", 3), ("12", 12), ("5 CONTAINERS", 5),
    ("TWO CONTAINERS", 2), ("1 x 40 ft HC", 1), ("10 X 40' HC", 10),
])
def test_container_count(value, count):
    assert parse_container_count(value)[0] == count


def test_container_types_and_blank():
    assert parse_container_count("2x20GP + 1x40HC")[1] == ["20GP", "40HC"]
    assert parse_container_count("")[0] is None
    assert parse_container_count("TBA")[0] is None


# ---------------------------------------------------------------- ports
@pytest.mark.parametrize("a,b", [
    ("PORT KLANG (WESTPORT), MALAYSIA (MYPKG)", "Port Klang, Malaysia"),
    ("Port Kelang", "PORT KLANG, MALAYSIA"),
    ("NANTONG, CHINA (CNNTG)", "NANTONG, CHINA"),
    ("SINGAPORE", "SINGAPORE, SINGAPORE (SGSIN)"),
    ("HOCHIMINH CITY, VIETNAM", "Ho Chi Minh City, Viet Nam"),
    ("Nhava Sheva, India", "JNPT, INDIA"),
    ("NEW YORK, US", "New York, USA"),
    ("Port of Rotterdam, Netherlands", "ROTTERDAM"),
    ("BUSAN, SOUTH KOREA", "Pusan, Korea"),
])
def test_same_port(a, b):
    assert normalise_port(a)["key"] == normalise_port(b)["key"]


@pytest.mark.parametrize("a,b", [
    ("SINGAPORE, SINGAPORE (MYPKG)", "PORT KLANG (WESTPORT), MALAYSIA (MYPKG)"),   # same code, different name
    ("NANTONG, CHINA", "RUGAO/NANTONG/SHANGHAI, CHINA"),
    ("MOMBASA, KENYA (KEMBA)", "TUTICORIN, INDIA (KEMBA)"),
])
def test_different_port(a, b):
    assert normalise_port(a)["key"] != normalise_port(b)["key"]


def test_port_parts_and_kb_alias():
    p = normalise_port("PORT KLANG (WESTPORT), MALAYSIA (MYPKG)")
    assert (p["city"], p["country"], p["locode"]) == ("PORT KLANG", "MALAYSIA", "MYPKG")
    assert normalise_port("TG PRIOK", {"TG PRIOK": "JAKARTA"})["key"] == "JAKARTA"


# ---------------------------------------------------------------- parties
@pytest.mark.parametrize("a,b", [
    ("APRIL FAR EAST (M) SDN BHD", "April Far East (M) Sdn. Bhd."),
    ("MOORIM SP CO., LTD", "MOORIM SP CO LTD"),
    ("KPP-ANTALIS (SINGAPORE) PTE. LTD.", "KPP ANTALIS (SINGAPORE) PTE LTD"),
    ("To the Order of ROXCEL TRADING GMBH", "ROXCEL TRADING GMBH"),
    ("BALL & DOGGETT AUSTRALIA PTY LTD", "Ball and Doggett Australia Pty Limited"),
    ("AL GURG STATIONERY L.L.C.", "AL GURG STATIONERY LLC"),
    ("PACIFIC OFFICE (M) SENDIRIAN BERHAD", "PACIFIC OFFICE (M) SDN BHD"),
    ("M/S NAGAPPA EXPORTS", "NAGAPPA EXPORTS"),
])
def test_same_party(a, b):
    assert normalise_party(a) == normalise_party(b)


@pytest.mark.parametrize("a,b", [
    ("APRIL FINE PAPER TRADING", "APRIL FINE PAPER TRADING (MIDDLE EAST) FZE"),
    ("EAST BRIGHT FZ-LLC", "UAB NOVAKOPA"),
    ("APRIL FAR EAST (M) SDN BHD", "ASIA PACIFIC PAPERBOARD TRADING PTE LTD"),
])
def test_different_party(a, b):
    assert normalise_party(a) != normalise_party(b)


def test_party_core_and_order_only():
    assert party_core(normalise_party("ROXCEL TRADING GMBH")) == party_core(normalise_party("ROXCEL TRADING"))
    assert is_order_only("TO ORDER") and is_order_only("To Order of Shipper")
    assert not is_order_only("TO THE ORDER OF ROXCEL TRADING GMBH")
